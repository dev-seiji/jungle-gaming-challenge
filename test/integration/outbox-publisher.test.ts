// Integração real: Postgres + SQS (MiniStack) do compose, no banco e na conta SQS exclusivos dos testes
// (ver .env.example), então o container `app` pode ficar de pé.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { EVENTS_QUEUE, OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { PostgresWagerStore } from '../../src/infrastructure/persistence/postgres-wager-store';
import { command, createWallet, initOrm } from './helpers';
import { SQS_ACCOUNT } from './helpers';

let orm: MikroORM;
let useCase: ProcessWagerTransaction;
const realSqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });

/** SQS real, mas contando quantas vezes cada evento foi ENVIADO por este publisher. */
function countingSqs(sent: string[]): SQSClient {
  return {
    send: (cmd: unknown, opts?: unknown) => {
      if (cmd instanceof SendMessageCommand) sent.push(cmd.input.MessageDeduplicationId!);
      return realSqs.send(cmd as never, opts as never);
    },
  } as SQSClient;
}

const sql = (query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute(query, params);

async function outboxRows(walletId: string) {
  return (await sql(
    `SELECT id, attempts, next_attempt_at, published_at FROM outbox_messages
      WHERE payload->'data'->>'walletId' = ? ORDER BY id`,
    [walletId],
  )) as { id: string; attempts: number; next_attempt_at: string | null; published_at: string | null }[];
}

/** Mensagens que estão na fila de eventos agora (endpoint de inspeção do MiniStack, não consome). */
async function queuedEventIds(): Promise<string[]> {
  const res = (await (await fetch(`${process.env.SQS_ENDPOINT}/_ministack/sqs/messages`)).json()) as any;
  const queues = res.messages[SQS_ACCOUNT]['us-east-1'] as Record<string, { Body: string }[]>;
  const events = Object.entries(queues).find(([url]) => url.endsWith(EVENTS_QUEUE))?.[1] ?? [];
  return events.map((m) => JSON.parse(m.Body).eventId as string);
}

/** Commit de uma BET: gera 2 eventos na outbox (Processed + BalanceChanged), ainda não publicados. */
async function committedBet() {
  const wallet = await createWallet(orm, '100.00');
  await useCase.execute(command(wallet), { correlationId: 'outbox-test' });
  return wallet;
}

async function drain(publishers: OutboxPublisher[], until: () => Promise<boolean>) {
  for (let i = 0; i < 50 && !(await until()); i++) {
    await Promise.all(publishers.map((p) => p.publishBatch()));
  }
}

beforeAll(async () => {
  orm = await initOrm();
  useCase = new ProcessWagerTransaction(new PostgresWagerStore(orm));
});

afterAll(async () => {
  await orm.close(true);
});

describe('outbox publisher', () => {
  test('commit done, process dies before publishing, another instance publishes it', async () => {
    // "Instância 1" fez commit e morreu: os eventos estão na outbox e ninguém publicou.
    const wallet = await committedBet();
    const pending = await outboxRows(wallet.walletId);
    expect(pending).toHaveLength(2);
    expect(pending.every((r) => r.published_at === null)).toBe(true);

    // "Instância 2" sobe depois e publica o que ficou pendente.
    const sent: string[] = [];
    await drain([new OutboxPublisher(orm, countingSqs(sent))], async () =>
      (await outboxRows(wallet.walletId)).every((r) => r.published_at !== null),
    );

    const published = await outboxRows(wallet.walletId);
    expect(published.every((r) => r.published_at !== null)).toBe(true);
    const queued = await queuedEventIds();
    for (const row of published) expect(queued).toContain(row.id);
  });

  test('two publishers on the same outbox: every event is sent exactly once (SKIP LOCKED)', async () => {
    const wallets = await Promise.all(Array.from({ length: 15 }, () => committedBet())); // 30 eventos
    const sentA: string[] = [];
    const sentB: string[] = [];
    const a = new OutboxPublisher(orm, countingSqs(sentA), { batchSize: 3 });
    const b = new OutboxPublisher(orm, countingSqs(sentB), { batchSize: 3 });

    const ours = async () => (await Promise.all(wallets.map((w) => outboxRows(w.walletId)))).flat();
    await drain([a, b], async () => (await ours()).every((r) => r.published_at !== null));

    const rows = await ours();
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
    const ourIds = new Set(rows.map((r) => r.id));
    const sentOurs = [...sentA, ...sentB].filter((id) => ourIds.has(id));
    expect(sentOurs).toHaveLength(30); // nenhum evento enviado duas vezes...
    expect(new Set(sentOurs).size).toBe(30);
    expect(sentA.filter((id) => ourIds.has(id)).length).toBeGreaterThan(0); // ...e os dois de fato trabalharam
    expect(sentB.filter((id) => ourIds.has(id)).length).toBeGreaterThan(0);
  });

  test('SQS down: event stays pending with backoff, then is published when SQS is back', async () => {
    const wallet = await committedBet();
    const deadSqs = new SQSClient({ endpoint: 'http://localhost:1', maxAttempts: 1 });
    const before = new Date();
    await new OutboxPublisher(orm, deadSqs).publishBatch();

    const failed = await outboxRows(wallet.walletId);
    expect(failed.every((r) => r.published_at === null)).toBe(true); // não se perdeu
    expect(failed.every((r) => r.attempts === 1)).toBe(true);
    expect(failed.every((r) => new Date(r.next_attempt_at!).getTime() > before.getTime())).toBe(true); // backoff

    // Antes do backoff vencer, ninguém tenta de novo.
    const sent: string[] = [];
    const healthy = new OutboxPublisher(orm, countingSqs(sent));
    await healthy.publishBatch(new Date());
    expect(sent.filter((id) => failed.some((r) => r.id === id))).toHaveLength(0);

    // Depois do backoff, o SQS "voltou": publica.
    await healthy.publishBatch(new Date(Date.now() + 2_000));
    expect((await outboxRows(wallet.walletId)).every((r) => r.published_at !== null)).toBe(true);
  });

  test('background loop publishes on its own and stops cleanly', async () => {
    const wallet = await committedBet();
    const publisher = new OutboxPublisher(orm, realSqs, { intervalMs: 50 });
    publisher.start();
    for (let i = 0; i < 40 && (await outboxRows(wallet.walletId)).some((r) => r.published_at === null); i++) {
      await Bun.sleep(50);
    }
    await publisher.stop();
    expect((await outboxRows(wallet.walletId)).every((r) => r.published_at !== null)).toBe(true);
  });
});
