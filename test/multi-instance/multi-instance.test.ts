// Várias instâncias REAIS do app (processos `bun src/main.ts` separados, cada um com seu pool, publisher,
// consumidor e worker) sobre o mesmo Postgres e MiniStack do compose. Também derruba e reinicia o Postgres.
// Rodar com: `docker compose up -d postgres ministack` + `docker compose stop app` + `bun run test:multi`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { GetQueueUrlCommand, PurgeQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Subprocess } from 'bun';
import { countRows, initOrm } from '../integration/helpers';

const PORTS = [3101, 3102, 3103];
const instances = new Map<number, Subprocess>();
let orm: MikroORM;
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
const brl = (amount: string) => ({ amount, currency: 'BRL' });
const SLOW = 90_000; // timeout por teste: estes cenários sobem processos e reiniciam o banco

// ---------- processos

async function startInstance(port: number): Promise<void> {
  // Um arquivo por processo (não sobrescreve o log da instância anterior na mesma porta, ex.: depois do kill -9).
  const log = Bun.file(`${tmpdir()}/wagering-instance-${port}-${Date.now()}.log`);
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      OUTBOX_PUBLISHER_ENABLED: 'true',
      SQS_CONSUMER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
    },
    stdout: log,
    stderr: log,
  });
  instances.set(port, proc);
  await waitUntil(async () => (await fetch(`http://localhost:${port}/health/ready`).catch(() => null))?.status === 200, 20_000);
}

function killHard(port: number): void {
  instances.get(port)?.kill('SIGKILL'); // sem shutdown limpo: simula queda abrupta do processo
  instances.delete(port);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error('condition not met in time');
}

async function compose(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', 'compose', ...args], { stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
}

// ---------- HTTP

async function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function newWallet(balance: string, port = PORTS[0]!) {
  const res = await call(port, 'POST', '/wallets', { playerId: Bun.randomUUIDv7(), initialBalance: brl(balance) });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

function bet(wallet: { id: string; playerId: string }, amount: string, ext = `tx-${Bun.randomUUIDv7()}`) {
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game',
      kind: 'BET',
      money: brl(amount),
    },
    key: `provider-a:${ext}`,
  };
}

const submit = (port: number, w: { body: unknown; key: string }) =>
  call(port, 'POST', '/wagering/transactions', w.body, { 'idempotency-key': w.key });

/** Invariante final: saldo gravado == saldo reconstruído pelo ledger (endpoint de reconciliação). */
async function expectConsistent(walletId: string, expectedBalance: string, port = PORTS[0]!) {
  const { body } = await call(port, 'POST', `/wallets/${walletId}/reconciliation`);
  expect(body.consistent).toBe(true);
  expect(body.storedBalance.amount).toBe(expectedBalance);
}

const debits = (walletId: string) =>
  countRows(orm, 'wallet_ledger_entries', `wallet_id = ? AND direction = 'DEBIT'`, [walletId]);

// ---------- ciclo de vida

beforeAll(async () => {
  const appRunning = await fetch('http://localhost:3000/health/live').then(
    () => true,
    () => false,
  );
  if (appRunning) throw new Error('stop the app container first: `docker compose stop app`');
  orm = await initOrm();
  await Promise.all(PORTS.map(startInstance));
}, SLOW);

afterAll(async () => {
  for (const proc of instances.values()) proc.kill('SIGTERM');
  await Promise.all([...instances.values()].map((p) => p.exited));
  await orm?.close(true);
});

// ---------- cenários

describe('3 instances at the same time', () => {
  test('hot wallet attacked by the 3 instances: the lock holds across processes', async () => {
    const wallet = await newWallet('100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => submit(PORTS[i % 3]!, bet(wallet, '7.00'))),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(14); // 14 x 7 = 98
    expect(results.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(16);
    expect(await debits(wallet.id)).toBe(14);
    await expectConsistent(wallet.id, '2.00');
  }, SLOW);

  test('the same BET sent 30 times across the 3 instances debits once', async () => {
    const wallet = await newWallet('100.00');
    const same = bet(wallet, '25.00');
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(PORTS[i % 3]!, same)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(await debits(wallet.id)).toBe(1);
    await expectConsistent(wallet.id, '75.00');
  }, SLOW);

  test('queue: 3 consumers share 30 messages, each applied exactly once; 3 publishers drain the outbox', async () => {
    const commandsUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }))).QueueUrl!;
    await sqs.send(new PurgeQueueCommand({ QueueUrl: commandsUrl }));
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const w = wallets[i % 10]!;
      const { body, key } = bet(w, '10.00');
      keys.push(key);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: commandsUrl,
          MessageGroupId: w.id, // ordem por wallet; wallets diferentes em paralelo
          MessageDeduplicationId: Bun.randomUUIDv7(),
          MessageBody: JSON.stringify({
            messageId: `msg-${Bun.randomUUIDv7()}`,
            type: 'WagerTransactionRequested',
            occurredAt: new Date().toISOString(),
            data: { ...body, idempotencyKey: key },
          }),
        }),
      );
    }
    const placeholders = keys.map(() => '?').join(', ');
    let processed = 0;
    await waitUntil(async () => {
      processed = await countRows(orm, 'wager_transactions', `idempotency_key IN (${placeholders})`, keys);
      return processed === 30;
    }, 30_000).catch((e) => {
      throw new Error(`only ${processed}/30 messages processed: ${e.message}`);
    });
    for (const w of wallets) {
      expect(await debits(w.id)).toBe(3);
      await expectConsistent(w.id, '70.00');
    }
    // Eventos dessas wallets publicados pelos 3 publishers concorrentes.
    const walletIds = wallets.map((w) => w.id);
    const inWallets = `payload->'data'->>'walletId' IN (${walletIds.map(() => '?').join(', ')})`;
    let unpublished = -1;
    await waitUntil(async () => {
      unpublished = await countRows(orm, 'outbox_messages', `${inWallets} AND published_at IS NULL`, walletIds);
      return unpublished === 0;
    }, 30_000).catch((e) => {
      throw new Error(`${unpublished} events still unpublished: ${e.message}`);
    });
  }, SLOW);
});

describe('recovery', () => {
  test('instance killed with kill -9 in the middle of the load, restarted, provider resends everything', async () => {
    const port = PORTS[0]!;
    const wallet = await newWallet('1000.00', PORTS[1]);
    const bets = Array.from({ length: 40 }, () => bet(wallet, '5.00'));

    // Dispara tudo e mata o processo no meio: parte das requisições cai sem resposta.
    const inFlight = bets.map((b) => submit(port, b).catch(() => null));
    await Bun.sleep(30);
    killHard(port);
    const firstRound = await Promise.all(inFlight);
    // Garante que o kill pegou MESMO o meio da carga: algumas requisições ficaram sem resposta.
    expect(firstRound.filter((r) => r === null).length).toBeGreaterThan(0);

    // Instância volta; o provedor reenvia TODAS (mesma key) — algumas viram replay, as perdidas são processadas.
    await startInstance(port);
    const resent = await Promise.all(bets.map((b) => submit(port, b)));
    expect(resent.every((r) => r.status === 200)).toBe(true);
    expect(await debits(wallet.id)).toBe(40); // nem duplicou, nem perdeu
    await expectConsistent(wallet.id, '800.00');
  }, SLOW);

  test('a wallet lock held longer than lock_timeout answers 503 (transient) and counts the timeout', async () => {
    const wallet = await newWallet('100.00');
    const timeoutsBefore = await lockTimeouts(PORTS[1]!);
    // Outra transação segura a linha da wallet por 6s (mais que o lock_timeout de 5s).
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [wallet.id]);
      await Bun.sleep(6_000);
    });
    await Bun.sleep(100);
    const blocked = bet(wallet, '10.00');
    const res = await submit(PORTS[1]!, blocked);
    await holder;

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'TRANSIENT_FAILURE', retryable: true });
    expect(await lockTimeouts(PORTS[1]!)).toBe(timeoutsBefore + 1);
    // O provedor reenvia (mesma key) depois que o lock foi liberado: processa normalmente.
    expect((await submit(PORTS[1]!, blocked)).status).toBe(200);
    await expectConsistent(wallet.id, '90.00');
  }, SLOW);

  test('Postgres restarted during operation: 503 while down, recovers by itself, consistent at the end', async () => {
    const wallet = await newWallet('100.00');
    await submit(PORTS[0]!, bet(wallet, '10.00'));

    await compose('stop', 'postgres');
    const duringOutage = bet(wallet, '20.00');
    const down = await submit(PORTS[0]!, duringOutage);
    expect(down.status).toBe(503);
    expect(down.body.retryable).toBe(true);
    expect((await fetch(`http://localhost:${PORTS[0]}/health/ready`)).status).toBe(503);
    expect((await fetch(`http://localhost:${PORTS[0]}/health/live`)).status).toBe(200); // processo segue vivo

    await compose('start', 'postgres');
    // As instâncias voltam SOZINHAS (sem reiniciar o app): o pool descarta as conexões mortas.
    await waitUntil(async () => (await fetch(`http://localhost:${PORTS[0]}/health/ready`)).status === 200, 30_000);
    // O provedor reenvia o que recebeu 503 (mesma key): agora processa.
    expect((await submit(PORTS[2]!, duringOutage)).status).toBe(200);
    // O ORM do próprio teste também perdeu as conexões: recria para as checagens finais.
    await orm.close(true);
    orm = await initOrm();
    expect(await debits(wallet.id)).toBe(2);
    await expectConsistent(wallet.id, '70.00', PORTS[1]);
  }, SLOW);
});

async function lockTimeouts(port: number): Promise<number> {
  const text = await (await fetch(`http://localhost:${port}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith('wallet_lock_timeouts_total '));
  return line ? Number(line.split(' ')[1]) : 0;
}
