// Integração real pela HTTP: sobe o app Nest inteiro (com Postgres do compose) e chama com fetch.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { DriverException } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module';
import { toHttpError } from '../../src/http/http-error.filter';
import { expectBalanceMatchesLedger } from './helpers';

let app: INestApplication;
let base: string;
let orm: MikroORM;

beforeAll(async () => {
  // Workers em segundo plano desligados: senão disputariam fila/outbox com os testes do consumidor e do publisher.
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  orm = app.get(MikroORM);
  await orm.migrator.up();
});

afterAll(async () => {
  await app.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(balance = '100.00') {
  const res = await call('POST', '/wallets', { playerId: Bun.randomUUIDv7(), initialBalance: brl(balance) });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

function wager(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `tx-${Bun.randomUUIDv7()}`;
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      ...overrides,
    },
    key: `provider-a:${externalTransactionId}`,
  };
}

const submit = (w: { body: unknown; key: string }) =>
  call('POST', '/wagering/transactions', w.body, { 'idempotency-key': w.key });

describe('POST /wallets', () => {
  test('201 with version 1; initial balance comes from an OPENING CREDIT in the ledger', async () => {
    const playerId = Bun.randomUUIDv7();
    const res = await call('POST', '/wallets', { playerId, initialBalance: brl('1000.00') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });

    const ledger = await call('GET', `/wallets/${res.body.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ direction: 'CREDIT', money: brl('1000.00'), balanceBefore: brl('0.00') });
    expect(await expectBalanceMatchesLedger(orm as never, res.body.id)).toBe('1000.00');
  });

  test('zero initial balance: wallet without ledger entry', async () => {
    const wallet = await newWallet('0.00');
    expect((await call('GET', `/wallets/${wallet.id}/ledger`)).body.items).toEqual([]);
  });

  test('409 for a second wallet of the same player and currency; another currency is fine', async () => {
    const playerId = Bun.randomUUIDv7();
    await call('POST', '/wallets', { playerId, initialBalance: brl('10.00') });
    const dup = await call('POST', '/wallets', { playerId, initialBalance: brl('10.00') });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('WALLET_ALREADY_EXISTS');
    const usd = await call('POST', '/wallets', { playerId, initialBalance: { amount: '10.00', currency: 'USD' } });
    expect(usd.status).toBe(201);
  });

  test('400 for invalid input', async () => {
    expect((await call('POST', '/wallets', { playerId: 'p', initialBalance: brl('10') })).status).toBe(400);
    expect((await call('POST', '/wallets', { initialBalance: brl('10.00') })).status).toBe(400);
    expect((await call('POST', '/wallets', { playerId: 'p' })).status).toBe(400);
  });
});

describe('GET /wallets/:walletId', () => {
  test('200 with balance and version; 404 for unknown or malformed id', async () => {
    const wallet = await newWallet('50.00');
    expect((await call('GET', `/wallets/${wallet.id}`)).body).toMatchObject({ balance: brl('50.00'), version: 1 });
    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(404);
  });
});

describe('POST /wagering/transactions — status mapping', () => {
  test('200 PROCESSED; replay returns the same response with idempotentReplay=true', async () => {
    const wallet = await newWallet();
    const bet = wager(wallet);
    const first = await submit(bet);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('75.00'),
      idempotentReplay: false,
    });
    const again = await submit(bet);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('409 same key with different payload', async () => {
    const wallet = await newWallet();
    const bet = wager(wallet);
    await submit(bet);
    const conflict = await submit({ ...bet, body: { ...bet.body, money: brl('26.00') } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  test('422 business rejection carries the failureCode (and replay is 422 again)', async () => {
    const wallet = await newWallet('10.00');
    const bet = wager(wallet, { money: brl('50.00') });
    const res = await submit(bet);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('10.00') });
    expect((await submit(bet)).status).toBe(422);
  });

  test('422 WALLET_NOT_FOUND for a wallet that does not exist', async () => {
    const res = await submit(wager({ id: Bun.randomUUIDv7(), playerId: 'p' }));
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('202 PENDING_REFERENCE when the reference has not arrived', async () => {
    const wallet = await newWallet();
    const res = await submit(wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test('400 for missing header, missing fields, bad amount, internal kind and malformed JSON', async () => {
    const wallet = await newWallet();
    const ok = wager(wallet);
    expect((await call('POST', '/wagering/transactions', ok.body)).status).toBe(400); // sem Idempotency-Key
    const { roundId: _, ...withoutRound } = ok.body;
    expect((await submit({ ...ok, body: withoutRound })).status).toBe(400);
    expect((await submit({ ...ok, body: { ...ok.body, money: brl('1e3') } })).status).toBe(400);
    expect((await submit({ ...ok, body: { ...ok.body, kind: 'OPENING' } })).status).toBe(400);
    const malformed = await fetch(`${base}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: '{"broken": ',
    });
    expect(malformed.status).toBe(400);
  });

  test('503 for transient infrastructure failures (mapping)', () => {
    const lockTimeout = Object.assign(new DriverException(new Error('canceling statement due to lock timeout')), {
      code: '55P03',
    });
    expect(toHttpError(lockTimeout)).toMatchObject({ status: 503, body: { error: 'TRANSIENT_FAILURE', retryable: true } });
    expect(toHttpError(new Error('Connection terminated unexpectedly')).status).toBe(503);
    expect(toHttpError(new Error('boom')).status).toBe(500);
  });
});

describe('transaction queries', () => {
  test('by internal id and by provider + external id; 404 when missing', async () => {
    const wallet = await newWallet();
    const bet = wager(wallet);
    const { body } = await submit(bet);
    const byId = await call('GET', `/wagering/transactions/${body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ transactionId: body.transactionId, status: 'PROCESSED', kind: 'BET', money: brl('25.00') });
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${bet.body.externalTransactionId}`);
    expect(byExternal.body.transactionId).toBe(body.transactionId);
    expect((await call('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('GET', '/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
  });
});

describe('GET /wallets/:walletId/ledger — cursor pagination', () => {
  test('walks all entries in order without repeating, even when new entries arrive between pages', async () => {
    const wallet = await newWallet('100.00');
    for (let i = 0; i < 5; i++) await submit(wager(wallet, { money: brl('1.00') }));

    const first = await call('GET', `/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.body.items).toHaveLength(2);
    // Chega um lançamento novo no meio da leitura: com cursor ele aparece no fim, sem deslocar as páginas.
    await submit(wager(wallet, { kind: 'WIN', money: brl('3.00') }));

    const seen = [...first.body.items];
    let cursor = first.body.nextCursor;
    while (cursor) {
      const page = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${cursor}`);
      seen.push(...page.body.items);
      cursor = page.body.nextCursor;
    }
    expect(seen).toHaveLength(7); // OPENING + 5 BET + 1 WIN
    expect(new Set(seen.map((e) => e.id)).size).toBe(7);
    expect(seen.map((e) => e.balanceAfter.amount)).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00', '95.00', '98.00']);
  });

  test('400 for invalid limit or cursor; 404 for unknown wallet', async () => {
    const wallet = await newWallet();
    expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=101`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=abc`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistent wallet', async () => {
    const wallet = await newWallet('100.00');
    await submit(wager(wallet, { money: brl('25.00') }));
    const res = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('75.00'),
      calculatedBalance: brl('75.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergence is reported, not silently fixed', async () => {
    const wallet = await newWallet('100.00');
    // Simula corrupção: alguém mexeu no saldo por fora (o ledger é imutável, a wallet não).
    await orm.em.fork().getConnection().execute(`UPDATE wallets SET balance = 90 WHERE id = ?`, [wallet.id]);
    const res = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(res.body).toMatchObject({ consistent: false, difference: brl('-10.00'), storedBalance: brl('90.00') });
    // continua divergente: nada foi "consertado"
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance).toEqual(brl('90.00'));
  });

  test('404 for unknown wallet', async () => {
    expect((await call('POST', `/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
  });
});
