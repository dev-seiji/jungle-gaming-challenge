// Integração real: Postgres + SQS (MiniStack). O container `app` precisa estar PARADO (`docker compose stop app`):
// ele também consome wager-transactions.fifo e "roubaria" as mensagens dos testes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GetQueueUrlCommand, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import type { WagerStore } from '../../src/application/wager-store';
import {
  COMMANDS_QUEUE,
  CONSUMER_NAME,
  DEAD_LETTER_QUEUE,
  WagerConsumer,
} from '../../src/infrastructure/messaging/wager-consumer';
import { PostgresQueries } from '../../src/infrastructure/persistence/postgres-queries';
import { PostgresWagerStore } from '../../src/infrastructure/persistence/postgres-wager-store';
import { countRows, createWallet, expectBalanceMatchesLedger, initOrm, ledgerEntries } from './helpers';

let orm: MikroORM;
let store: PostgresWagerStore;
let queries: PostgresQueries;
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
let commandsUrl: string;
let dlqUrl: string;

/** Consumidor de teste: sem long polling e sem espera no retry (visibilidade 0 = volta na hora). */
function consumer(useCase = new ProcessWagerTransaction(store)) {
  return new WagerConsumer(useCase, queries, sqs, { waitTimeSeconds: 0, retryBaseSeconds: 0 });
}

/** Store que falha com erro transitório nas primeiras `times` chamadas (ou sempre). */
function flakyStore(times: number): WagerStore {
  let left = times;
  return {
    transaction: (work) => {
      if (left-- > 0) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      return store.transaction(work);
    },
  };
}

function envelope(wallet: { walletId: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = `tx-${Bun.randomUUIDv7()}`;
  return {
    messageId: `msg-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    },
  };
}

/** Envia para a fila de comandos. Cada envio tem dedup id próprio: simula o provedor reenviando. */
async function send(body: unknown, groupId = 'g') {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: commandsUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

/** Conteúdo atual de uma fila, sem consumir (endpoint de inspeção do MiniStack). */
async function queued(queueName: string): Promise<{ Body: string; IsVisible: boolean }[]> {
  const res = (await (await fetch(`${process.env.SQS_ENDPOINT}/_ministack/sqs/messages`)).json()) as any;
  const queues = res.messages['000000000000']['us-east-1'] as Record<string, { Body: string; IsVisible: boolean }[]>;
  return Object.entries(queues).find(([url]) => url.endsWith(`/${queueName}`))?.[1] ?? [];
}

const inboxCount = (messageId: string) =>
  countRows(orm, 'inbox_messages', 'consumer_name = ? AND message_id = ?', [CONSUMER_NAME, messageId]);

beforeAll(async () => {
  const appRunning = await fetch('http://localhost:3000/health/live').then(
    () => true,
    () => false,
  );
  if (appRunning) throw new Error('stop the app container first: `docker compose stop app` (it would compete for the queue)');
  orm = await initOrm();
  store = new PostgresWagerStore(orm);
  queries = new PostgresQueries(orm);
  commandsUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: COMMANDS_QUEUE }))).QueueUrl!;
  dlqUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: DEAD_LETTER_QUEUE }))).QueueUrl!;
});

beforeEach(async () => {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: commandsUrl }));
  await sqs.send(new PurgeQueueCommand({ QueueUrl: dlqUrl }));
});

afterAll(async () => {
  await orm.close(true);
});

describe('wager consumer', () => {
  test('happy path: processes via the same use case, writes inbox in the same commit, deletes the message', async () => {
    const wallet = await createWallet(orm, '100.00');
    const msg = envelope(wallet);
    await send(msg);

    expect(await consumer().pollOnce()).toBe(1);
    expect(await ledgerEntries(orm, wallet.walletId)).toEqual([{ direction: 'DEBIT', amount: '25.00', kind: 'BET' }]);
    expect(await inboxCount(msg.messageId)).toBe(1);
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('75.00');
  });

  test('redelivery: the same message delivered twice debits once', async () => {
    const wallet = await createWallet(orm, '100.00');
    const msg = envelope(wallet);
    await send(msg);
    await send(msg); // mesmo messageId, entregue de novo
    const c = consumer();
    await c.pollOnce();
    await c.pollOnce();

    expect(await ledgerEntries(orm, wallet.walletId)).toHaveLength(1);
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0); // as duas foram ack
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('75.00');
  });

  test('worker killed after commit and before ack: the redelivery is only acknowledged', async () => {
    const wallet = await createWallet(orm, '100.00');
    const msg = envelope(wallet);
    await send(msg);

    // "Worker 1": recebe, faz o commit (com inbox) e morre antes do DeleteMessage.
    const { Messages } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: commandsUrl, VisibilityTimeout: 0 }));
    expect(Messages).toHaveLength(1);
    await new ProcessWagerTransaction(store).execute(
      { ...msg.data },
      { correlationId: msg.messageId, inbox: { consumerName: CONSUMER_NAME, messageId: msg.messageId } },
    );
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(1); // não houve ack: a mensagem volta

    // "Worker 2" recebe a reentrega: o inbox diz que já foi processada -> só ack.
    expect(await consumer().pollOnce()).toBe(1);
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0);
    expect(await ledgerEntries(orm, wallet.walletId)).toHaveLength(1);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('75.00');
  });

  test('business rejection is acknowledged (terminal), not retried', async () => {
    const wallet = await createWallet(orm, '10.00');
    const msg = envelope(wallet, { money: { amount: '50.00', currency: 'BRL' } });
    await send(msg);
    await consumer().pollOnce();
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0);
    expect(await queued(DEAD_LETTER_QUEUE)).toHaveLength(0);
    expect(await countRows(orm, 'wager_transactions', `idempotency_key = ? AND failure_code = 'INSUFFICIENT_FUNDS'`, [msg.data.idempotencyKey])).toBe(1);
  });

  test('transient failure: message is kept and retried, then processed once', async () => {
    const wallet = await createWallet(orm, '100.00');
    const msg = envelope(wallet);
    await send(msg);
    const c = consumer(new ProcessWagerTransaction(flakyStore(1)));

    await c.pollOnce(); // banco "fora": não apaga, nada gravado
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(1);
    expect(await inboxCount(msg.messageId)).toBe(0);

    await c.pollOnce(); // banco "voltou"
    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0);
    expect(await ledgerEntries(orm, wallet.walletId)).toHaveLength(1);
  });

  test('transient failure that never ends: after maxReceiveCount the queue moves it to the DLQ', async () => {
    const wallet = await createWallet(orm, '100.00');
    const msg = envelope(wallet);
    await send(msg);
    const c = consumer(new ProcessWagerTransaction(flakyStore(Number.POSITIVE_INFINITY)));
    for (let i = 0; i < 7; i++) await c.pollOnce();

    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0);
    const dead = await queued(DEAD_LETTER_QUEUE);
    expect(dead).toHaveLength(1);
    expect(JSON.parse(dead[0]!.Body).messageId).toBe(msg.messageId);
    expect(await ledgerEntries(orm, wallet.walletId)).toHaveLength(0);
  });

  test('permanent errors go straight to the DLQ: malformed JSON, invalid amount, idempotency conflict', async () => {
    const wallet = await createWallet(orm, '100.00');
    const ok = envelope(wallet);
    await send(ok);
    await consumer().pollOnce();

    await send('not json at all');
    await send(envelope(wallet, { money: { amount: '10.5', currency: 'BRL' } }));
    await send({ ...envelope(wallet), data: { ...ok.data, money: { amount: '99.00', currency: 'BRL' } } }); // mesma key, outro payload
    const c = consumer();
    for (let i = 0; i < 3; i++) await c.pollOnce();

    expect(await queued(COMMANDS_QUEUE)).toHaveLength(0);
    expect(await queued(DEAD_LETTER_QUEUE)).toHaveLength(3);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('75.00'); // só o primeiro débito
  });

  test('stop (SIGTERM): finishes the in-flight message and returns the others to the queue', async () => {
    const wallet = await createWallet(orm, '100.00');
    const messages = [envelope(wallet), envelope(wallet), envelope(wallet)];
    for (const m of messages) await send(m);

    // Store que segura a 1ª mensagem até o teste pedir o stop.
    let releaseFirst!: () => void;
    const firstStarted = Promise.withResolvers<void>();
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const slowStore: WagerStore = {
      transaction: async (work) => {
        if (calls++ === 0) {
          firstStarted.resolve();
          await gate;
        }
        return store.transaction(work);
      },
    };
    const c = consumer(new ProcessWagerTransaction(slowStore));
    c.start();
    await firstStarted.promise; // a 1ª está em andamento
    const stopping = c.stop(); // "SIGTERM"
    releaseFirst();
    await stopping;

    expect(await ledgerEntries(orm, wallet.walletId)).toHaveLength(1); // a em andamento terminou
    const left = await queued(COMMANDS_QUEUE);
    expect(left).toHaveLength(2); // as outras voltaram para a fila...
    expect(left.every((m) => m.IsVisible)).toBe(true); // ...visíveis na hora para outra instância
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('75.00');
  });
});
