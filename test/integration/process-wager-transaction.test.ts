// Integração real: Postgres do compose, paralelismo real (cada chamada usa sua própria conexão e transação).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction, type ProcessContext } from '../../src/application/process-wager-transaction';
import { IdempotencyConflictError, type WagerStore } from '../../src/application/wager-store';
import { InvalidInputError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionStatus as Status } from '../../src/domain/wager-transaction';
import { PostgresWagerStore } from '../../src/infrastructure/persistence/postgres-wager-store';
import {
  command,
  countRows,
  createWallet,
  expectBalanceMatchesLedger,
  initOrm,
  ledgerEntries,
  outboxEventTypes,
  walletRow,
} from './helpers';

let orm: MikroORM;
let useCase: ProcessWagerTransaction;
const ctx: ProcessContext = { correlationId: 'test' };
const brl = (amount: string) => ({ amount, currency: 'BRL' });

beforeAll(async () => {
  orm = await initOrm();
  useCase = new ProcessWagerTransaction(new PostgresWagerStore(orm));
});

afterAll(async () => {
  await orm.close(true);
});

describe('concurrency (real parallel transactions)', () => {
  test('mandatory scenario: balance 100.00, two BETs of 80.00 at the same time', async () => {
    const wallet = await createWallet(orm, '100.00');
    const results = await Promise.all([
      useCase.execute(command(wallet, { money: brl('80.00') }), ctx),
      useCase.execute(command(wallet, { money: brl('80.00') }), ctx),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === Status.Rejected)!.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('20.00');
    expect(await ledgerEntries(orm, wallet.walletId)).toEqual([{ direction: 'DEBIT', amount: '80.00', kind: 'BET' }]);
    expect((await walletRow(orm, wallet.walletId)).version).toBe(2);
  });

  test('the same BET sent 50 times in parallel debits exactly once', async () => {
    const wallet = await createWallet(orm, '100.00');
    const sameBet = command(wallet, { money: brl('30.00') });
    const results = await Promise.all(Array.from({ length: 50 }, () => useCase.execute(sameBet, ctx)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    // Todos os replays devolvem o saldo observado na primeira execução.
    expect(results.every((r) => r.balance?.amount === '70.00')).toBe(true);
    expect(await ledgerEntries(orm, wallet.walletId)).toHaveLength(1);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('70.00');
  });

  test('the same transaction for a missing wallet sent 20 times in parallel is stored once (no lock to queue on)', async () => {
    const ghost = { walletId: Bun.randomUUIDv7(), playerId: 'p' };
    const cmd = command(ghost);
    const results = await Promise.all(Array.from({ length: 20 }, () => useCase.execute(cmd, ctx)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.failureCode === 'WALLET_NOT_FOUND')).toBe(true);
    expect(await countRows(orm, 'wager_transactions', 'idempotency_key = ?', [cmd.idempotencyKey])).toBe(1);
  });

  test('different wallets are processed in parallel, each one correct', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(orm, '50.00')));
    const results = await Promise.all(
      wallets.flatMap((w) => [
        useCase.execute(command(w, { money: brl('20.00') }), ctx),
        useCase.execute(command(w, { money: brl('20.00') }), ctx),
        useCase.execute(command(w, { kind: 'WIN', money: brl('5.00') }), ctx),
      ]),
    );
    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    for (const w of wallets) expect(await expectBalanceMatchesLedger(orm, w.walletId)).toBe('15.00');
  });

  test('a hot wallet with many concurrent BETs never goes negative', async () => {
    const wallet = await createWallet(orm, '100.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => useCase.execute(command(wallet, { money: brl('7.00') }), ctx)),
    );
    // 100 / 7 = 14 apostas cabem; as outras 16 são rejeitadas.
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(14);
    expect(results.filter((r) => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(16);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('2.00');
  });
});

describe('idempotency', () => {
  test('replay returns the original result, including the balance observed at that moment', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet, { money: brl('30.00') });
    const first = await useCase.execute(bet, ctx);
    await useCase.execute(command(wallet, { kind: 'WIN', money: brl('50.00') }), ctx); // saldo vai a 120
    const again = await useCase.execute(bet, ctx);

    expect(first).toMatchObject({ status: 'PROCESSED', balance: brl('70.00'), idempotentReplay: false });
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('120.00');
  });

  test('replay of a rejection returns the same rejection', async () => {
    const wallet = await createWallet(orm, '10.00');
    const bet = command(wallet, { money: brl('50.00') });
    const first = await useCase.execute(bet, ctx);
    const again = await useCase.execute(bet, ctx);
    expect(first.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(again).toEqual({ ...first, idempotentReplay: true });
  });

  test('same idempotency key with a different payload is a conflict, not a replay', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet, { money: brl('10.00') });
    await useCase.execute(bet, ctx);
    await expect(useCase.execute({ ...bet, money: brl('10.01') }, ctx)).rejects.toThrow(IdempotencyConflictError);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('90.00');
  });

  test('same externalTransactionId with another idempotency key is a conflict', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet);
    await useCase.execute(bet, ctx);
    await expect(useCase.execute({ ...bet, idempotencyKey: 'other-key' }, ctx)).rejects.toThrow(IdempotencyConflictError);
  });

  test('invalid input is refused before touching the database', async () => {
    const wallet = await createWallet(orm, '100.00');
    await expect(useCase.execute(command(wallet, { money: brl('10.5') }), ctx)).rejects.toThrow(InvalidInputError);
    await expect(useCase.execute(command(wallet, { kind: 'OPENING' }), ctx)).rejects.toThrow(InvalidInputError);
    await expect(useCase.execute(command({ ...wallet, walletId: 'not-a-uuid' }), ctx)).rejects.toThrow(InvalidInputError);
  });
});

describe('business rules end to end', () => {
  test('BET, WIN and LOSS: LOSS is PROCESSED without ledger entry and without WalletBalanceChanged', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = await useCase.execute(command(wallet, { money: brl('25.00') }), ctx);
    const win = await useCase.execute(command(wallet, { kind: 'WIN', money: brl('40.00') }), ctx);
    const loss = await useCase.execute(command(wallet, { kind: 'LOSS', money: brl('25.00') }), ctx);

    expect(loss).toMatchObject({ status: 'PROCESSED', balance: brl('115.00') });
    expect(await ledgerEntries(orm, wallet.walletId)).toEqual([
      { direction: 'DEBIT', amount: '25.00', kind: 'BET' },
      { direction: 'CREDIT', amount: '40.00', kind: 'WIN' },
    ]);
    expect(await outboxEventTypes(orm, [loss.transactionId])).toEqual(['WagerTransactionProcessed']);
    expect(await outboxEventTypes(orm, [bet.transactionId, win.transactionId, wallet.walletId])).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('115.00');
  });

  test('REFUND credits the BET back once; a second REFUND or a ROLLBACK of the same BET is ALREADY_REVERSED', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet, { money: brl('30.00') });
    await useCase.execute(bet, ctx);
    const reverse = (kind: string) =>
      useCase.execute(command(wallet, { kind, money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId }), ctx);

    expect(await reverse('REFUND')).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await reverse('REFUND')).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect(await reverse('ROLLBACK')).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });

  test('concurrent REFUNDs of the same BET: exactly one credits', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet, { money: brl('30.00') });
    await useCase.execute(bet, ctx);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        useCase.execute(
          command(wallet, { kind: 'REFUND', money: brl('30.00'), referenceExternalTransactionId: bet.externalTransactionId }),
          ctx,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(9);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });

  test('ROLLBACK of a WIN debits it back; if the credit was already spent it is REVERSAL_WOULD_OVERDRAW', async () => {
    const wallet = await createWallet(orm, '10.00');
    const win = command(wallet, { kind: 'WIN', money: brl('50.00') });
    await useCase.execute(win, ctx);
    await useCase.execute(command(wallet, { money: brl('55.00') }), ctx); // gasta o prêmio: saldo 5.00
    const rollback = await useCase.execute(
      command(wallet, { kind: 'ROLLBACK', money: brl('50.00'), referenceExternalTransactionId: win.externalTransactionId }),
      ctx,
    );
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: brl('5.00') });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('5.00');
  });

  test('ROLLBACK of a BET credits it back', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet, { money: brl('40.00') });
    await useCase.execute(bet, ctx);
    const rollback = await useCase.execute(
      command(wallet, { kind: 'ROLLBACK', money: brl('40.00'), referenceExternalTransactionId: bet.externalTransactionId }),
      ctx,
    );
    expect(rollback).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });

  test('REFUND arriving before its BET waits as PENDING_REFERENCE (no balance change)', async () => {
    const wallet = await createWallet(orm, '100.00');
    const refund = await useCase.execute(
      command(wallet, { kind: 'REFUND', money: brl('30.00'), referenceExternalTransactionId: 'bet-not-yet-arrived' }),
      ctx,
    );
    expect(refund).toMatchObject({ status: 'PENDING_REFERENCE', balance: brl('100.00') });
    expect(await outboxEventTypes(orm, [refund.transactionId])).toEqual(['WagerTransactionPendingReference']);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });

  test('reference rules: wrong amount and wrong kind are rejected with their codes', async () => {
    const wallet = await createWallet(orm, '100.00');
    const bet = command(wallet, { money: brl('30.00') });
    const win = command(wallet, { kind: 'WIN', money: brl('30.00') });
    await useCase.execute(bet, ctx);
    await useCase.execute(win, ctx);
    const amount = await useCase.execute(
      command(wallet, { kind: 'REFUND', money: brl('29.99'), referenceExternalTransactionId: bet.externalTransactionId }),
      ctx,
    );
    const kind = await useCase.execute(
      command(wallet, { kind: 'REFUND', money: brl('30.00'), referenceExternalTransactionId: win.externalTransactionId }),
      ctx,
    );
    expect(amount.failureCode).toBe(FailureCode.AmountMismatch);
    expect(kind.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  test('wallet not found, wallet of another player and currency mismatch are stored as REJECTED', async () => {
    const wallet = await createWallet(orm, '100.00');
    const notFound = await useCase.execute(command({ walletId: Bun.randomUUIDv7(), playerId: 'p' }), ctx);
    const otherPlayer = await useCase.execute(command({ ...wallet, playerId: 'someone-else' }), ctx);
    const usd = await useCase.execute(command(wallet, { money: { amount: '10.00', currency: 'USD' } }), ctx);

    expect(notFound).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND' });
    expect(notFound.balance).toBeUndefined();
    expect(otherPlayer).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    // saldo observado na moeda da WALLET, não na da transação
    expect(usd).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: brl('100.00') });
    expect(await outboxEventTypes(orm, [usd.transactionId])).toEqual(['WagerTransactionRejected']);
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });
});

describe('atomicity: transaction + balance + ledger + outbox + inbox commit together or not at all', () => {
  test('from the queue, the inbox row is written in the same commit', async () => {
    const wallet = await createWallet(orm, '100.00');
    const messageId = `msg-${Bun.randomUUIDv7()}`;
    await useCase.execute(command(wallet), { ...ctx, inbox: { consumerName: 'wager-consumer', messageId } });
    expect(await countRows(orm, 'inbox_messages', 'message_id = ? AND processed_at IS NOT NULL', [messageId])).toBe(1);
  });

  test('a failure after everything was staged rolls back everything', async () => {
    const wallet = await createWallet(orm, '100.00');
    const real = new PostgresWagerStore(orm);
    // Store que deixa o caso de uso preparar tudo e então falha antes do commit (simula a falha no meio).
    const failing: WagerStore = {
      transaction: (work) =>
        real.transaction(async (uow) => {
          await work(uow);
          throw new Error('crash before commit');
        }),
    };
    const cmd = command(wallet, { money: brl('60.00') });
    await expect(new ProcessWagerTransaction(failing).execute(cmd, { ...ctx, inbox: { consumerName: 'c', messageId: cmd.externalTransactionId } })).rejects.toThrow('crash before commit');

    expect(await countRows(orm, 'wager_transactions', 'idempotency_key = ?', [cmd.idempotencyKey])).toBe(0);
    expect(await countRows(orm, 'outbox_messages', `payload->'data'->>'walletId' = ?`, [wallet.walletId])).toBe(0);
    expect(await countRows(orm, 'inbox_messages', 'message_id = ?', [cmd.externalTransactionId])).toBe(0);
    expect(await walletRow(orm, wallet.walletId)).toEqual({ balance: '100.00', version: 1 });
    expect(await expectBalanceMatchesLedger(orm, wallet.walletId)).toBe('100.00');
  });
});
