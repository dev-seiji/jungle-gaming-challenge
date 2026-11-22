// Integração real (Postgres do compose), no banco exclusivo dos testes: o worker do container `app` não enxerga estas pendentes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { ResolvePendingReference } from '../../src/application/resolve-pending-reference';
import { PostgresWagerStore } from '../../src/infrastructure/persistence/postgres-wager-store';
import { command, createWallet, expectBalanceMatchesLedger, initOrm, ledgerEntries, outboxEventTypes } from './helpers';

let orm: MikroORM;
let useCase: ProcessWagerTransaction;
let resolver: ResolvePendingReference;
const ctx = { correlationId: 'pending-test' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });
const HOUR = 3_600_000;

async function txRow(id: string) {
  const [row] = await orm.em
    .fork()
    .getConnection()
    .execute(`SELECT status, failure_code, reference_attempts FROM wager_transactions WHERE id = ?`, [id]);
  return row as { status: string; failure_code: string | null; reference_attempts: number };
}

/** Roda o worker no instante `now` até não haver mais pendentes vencidas (inclui sobras de outros testes). */
async function drainAt(now: Date, workers: ResolvePendingReference[] = [resolver]) {
  for (let i = 0; i < 500; i++) {
    const found = await Promise.all(workers.map((w) => w.runOnce(now)));
    if (!found.some(Boolean)) return;
  }
}

beforeAll(async () => {
  orm = await initOrm();
  const store = new PostgresWagerStore(orm);
  useCase = new ProcessWagerTransaction(store);
  resolver = new ResolvePendingReference(store);
});

afterAll(async () => {
  await orm.close(true);
});

describe('PENDING_REFERENCE worker', () => {
  test('REFUND arrives before its BET: waits, then the worker applies it once the BET exists', async () => {
    const wallet = await createWallet(orm, '100.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const refundCmd = command(wallet, { kind: 'REFUND', money: brl('30.00'), referenceExternalTransactionId: betId });
    const refund = await useCase.execute(refundCmd, ctx);
    expect(refund.status as string).toBe('PENDING_REFERENCE');

    await useCase.execute(command(wallet, { externalTransactionId: betId, money: brl('30.00') }), ctx); // a BET chega: 70
    await drainAt(new Date(Date.now() + HOUR));

    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PROCESSED', failure_code: null });
    expect(await ledgerEntries(orm, wallet.walletId)).toEqual([
      { direction: 'DEBIT', amount: '30.00', kind: 'BET' },
      { direction: 'CREDIT', amount: '30.00', kind: 'REFUND' },
    ]);
    expect(await outboxEventTypes(orm, [refund.transactionId])).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    // Reenvio do REFUND agora devolve o estado decidido (PROCESSED), não mais o pendente.
    expect(await useCase.execute(refundCmd, ctx)).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });

  test('ROLLBACK arrives before its WIN: the worker debits it back once the WIN exists', async () => {
    const wallet = await createWallet(orm, '10.00');
    const winId = `win-${Bun.randomUUIDv7()}`;
    const rollback = await useCase.execute(
      command(wallet, { kind: 'ROLLBACK', money: brl('50.00'), referenceExternalTransactionId: winId }),
      ctx,
    );
    await useCase.execute(command(wallet, { externalTransactionId: winId, kind: 'WIN', money: brl('50.00') }), ctx); // 60
    await drainAt(new Date(Date.now() + HOUR));

    expect((await txRow(rollback.transactionId)).status).toBe('PROCESSED');
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('10.00');
  });

  test('reference never arrives: after 8 attempts it is REJECTED with REFERENCE_NOT_FOUND and an event', async () => {
    const wallet = await createWallet(orm, '100.00');
    const refund = await useCase.execute(
      command(wallet, { kind: 'REFUND', money: brl('30.00'), referenceExternalTransactionId: `ghost-${Bun.randomUUIDv7()}` }),
      ctx,
    );
    const attempts: number[] = [];
    for (let day = 1; day <= 10; day++) {
      await drainAt(new Date(Date.now() + day * 24 * HOUR)); // cada "dia" vence o próximo backoff
      attempts.push((await txRow(refund.transactionId)).reference_attempts);
    }

    expect(attempts.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // uma tentativa por rodada, até o limite
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await outboxEventTypes(orm, [refund.transactionId])).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });

  test('before the backoff is due, nobody touches it', async () => {
    const wallet = await createWallet(orm, '100.00');
    const refund = await useCase.execute(
      command(wallet, { kind: 'REFUND', money: brl('30.00'), referenceExternalTransactionId: `later-${Bun.randomUUIDv7()}` }),
      ctx,
    );
    await drainAt(new Date()); // agora: a 1ª tentativa só vence em 5s
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 0 });
  });

  test('reference arrives with a different amount: REJECTED with AMOUNT_MISMATCH', async () => {
    const wallet = await createWallet(orm, '100.00');
    const betId = `bet-${Bun.randomUUIDv7()}`;
    const refund = await useCase.execute(
      command(wallet, { kind: 'REFUND', money: brl('29.99'), referenceExternalTransactionId: betId }),
      ctx,
    );
    await useCase.execute(command(wallet, { externalTransactionId: betId, money: brl('30.00') }), ctx);
    await drainAt(new Date(Date.now() + HOUR));
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH' });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('70.00');
  });

  test('two workers at the same time: every pending refund is applied exactly once (SKIP LOCKED)', async () => {
    const wallet = await createWallet(orm, '100.00');
    const refunds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const betId = `bet-${Bun.randomUUIDv7()}`;
      const r = await useCase.execute(
        command(wallet, { kind: 'REFUND', money: brl('5.00'), referenceExternalTransactionId: betId }),
        ctx,
      );
      refunds.push(r.transactionId);
      await useCase.execute(command(wallet, { externalTransactionId: betId, money: brl('5.00') }), ctx);
    }
    // saldo 50 (10 BETs de 5); os dois workers disputam as 10 pendentes
    const store = new PostgresWagerStore(orm);
    await drainAt(new Date(Date.now() + HOUR), [new ResolvePendingReference(store), new ResolvePendingReference(store)]);

    for (const id of refunds) expect((await txRow(id)).status).toBe('PROCESSED');
    const credits = (await ledgerEntries(orm, wallet.walletId)).filter((e) => e.kind === 'REFUND');
    expect(credits).toHaveLength(10);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });
});
