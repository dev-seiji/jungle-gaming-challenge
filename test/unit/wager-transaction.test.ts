import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { FailureCode } from '../../src/domain/failure-code';
import { InvalidInputError, InvalidTransactionStateError } from '../../src/domain/errors';
import { payloadHash } from '../../src/domain/payload-hash';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-22T12:00:00Z');

function tx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: `ext-${Math.random()}`,
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'round-1',
    gameId: 'game',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: at,
    ...overrides,
  });
}

function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const t = tx(overrides);
  t.markProcessed(undefined, at);
  return t;
}

describe('WagerTransaction.create', () => {
  test('starts PENDING', () => {
    expect(tx().status).toBe(Status.Pending);
  });

  test('OPENING is internal and cannot be submitted', () => {
    expect(() => tx({ kind: Kind.Opening })).toThrow(InvalidInputError);
  });

  test('unknown kind is rejected', () => {
    expect(() => tx({ kind: 'JACKPOT' as Kind })).toThrow(InvalidInputError);
  });

  test('amount must be greater than zero', () => {
    expect(() => tx({ money: brl('0.00') })).toThrow(InvalidInputError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => tx({ kind })).toThrow(InvalidInputError);
    expect(tx({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('WIN may reference a BET; BET and LOSS cannot reference anything', () => {
    expect(() => tx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' })).not.toThrow();
    expect(() => tx({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidInputError);
    expect(() => tx({ kind: Kind.Loss, referenceExternalTransactionId: 'x' })).toThrow(InvalidInputError);
  });
});

describe('state transitions', () => {
  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    t.markPendingReference();
    expect(t.status).toBe(Status.PendingReference);
    t.markProcessed('ref-internal-id', at);
    expect(t.status).toBe(Status.Processed);
    expect(t.referenceTransactionId).toBe('ref-internal-id');
    expect(t.processedAt).toEqual(at);
  });

  test('PENDING_REFERENCE → REJECTED with REFERENCE_NOT_FOUND', () => {
    const t = tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('cannot go to PENDING_REFERENCE twice', () => {
    const t = tx();
    t.markPendingReference();
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, at)],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InsufficientFunds)],
  ])('%s is terminal: every transition afterwards throws', (_label, toTerminal) => {
    const t = tx();
    toTerminal(t);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.AmountMismatch)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.AmountMismatch)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test('rehydrate does not revalidate: rebuilds a terminal state as it was stored', () => {
    const t = WagerTransaction.rehydrate({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'key',
      payloadHash: 'hash',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'round-1',
      gameId: 'game',
      kind: Kind.Bet,
      money: brl('25.00'),
      createdAt: at,
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(t.status).toBe(Status.Rejected);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe('business rules per kind', () => {
  test('BET debits, WIN credits, LOSS does not touch balance, REFUND credits', () => {
    expect(tx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    const loss = tx({ kind: Kind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow();
  });

  test('ROLLBACK is the inverse of its reference', () => {
    const rollback = tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'r' });
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(
      rollback.ledgerDirectionFor(processed({ kind: Kind.Refund, referenceExternalTransactionId: 'b' })),
    ).toBe(LedgerDirection.Debit);
  });

  test('insufficient balance means different things for a BET and for a ROLLBACK', () => {
    expect(tx({ kind: Kind.Bet }).insufficientBalanceCode()).toBe(FailureCode.InsufficientFunds);
    expect(tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'w' }).insufficientBalanceCode()).toBe(
      FailureCode.ReversalWouldOverdraw,
    );
  });
});

describe('checkReference', () => {
  const refund = () => tx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
  const rollback = () => tx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });

  test('valid: REFUND of a PROCESSED BET with the same amount', () => {
    expect(refund().checkReference(processed({ kind: Kind.Bet }))).toBeUndefined();
  });

  test('valid: ROLLBACK of BET, WIN or REFUND', () => {
    expect(rollback().checkReference(processed({ kind: Kind.Bet }))).toBeUndefined();
    expect(rollback().checkReference(processed({ kind: Kind.Win }))).toBeUndefined();
    expect(rollback().checkReference(processed({ kind: Kind.Refund, referenceExternalTransactionId: 'b' }))).toBeUndefined();
  });

  test('REFUND only references BET', () => {
    expect(refund().checkReference(processed({ kind: Kind.Win }))).toBe(FailureCode.InvalidReferenceKind);
  });

  test('ROLLBACK cannot reference LOSS or another ROLLBACK', () => {
    expect(rollback().checkReference(processed({ kind: Kind.Loss }))).toBe(FailureCode.InvalidReferenceKind);
    expect(
      rollback().checkReference(processed({ kind: Kind.Rollback, referenceExternalTransactionId: 'y' })),
    ).toBe(FailureCode.InvalidReferenceKind);
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'p2' }],
    ['wallet', { walletId: 'w2' }],
    ['round', { roundId: 'round-2' }],
  ])('reference from another %s → REFERENCE_MISMATCH', (_label, other) => {
    expect(refund().checkReference(processed({ kind: Kind.Bet, ...other }))).toBe(FailureCode.ReferenceMismatch);
  });

  test('reference in another currency → CURRENCY_MISMATCH', () => {
    const usdBet = processed({ kind: Kind.Bet, money: Money.from({ amount: '25.00', currency: 'USD' }) });
    expect(refund().checkReference(usdBet)).toBe(FailureCode.CurrencyMismatch);
  });

  test('different amount → AMOUNT_MISMATCH (partial reversal is out of scope)', () => {
    expect(refund().checkReference(processed({ kind: Kind.Bet, money: brl('30.00') }))).toBe(FailureCode.AmountMismatch);
  });

  test('reference that was not applied → REFERENCE_NOT_PROCESSED', () => {
    const rejectedBet = tx({ kind: Kind.Bet });
    rejectedBet.reject(FailureCode.InsufficientFunds);
    expect(refund().checkReference(rejectedBet)).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('idempotency: payload hash', () => {
  const fields = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    kind: 'BET',
    money: brl('25.00'),
  };

  test('key order does not change the hash (canonical JSON)', () => {
    const reordered = { money: brl('25.00'), kind: 'BET', externalTransactionId: 'transaction-123', providerId: 'provider-a' };
    expect(payloadHash(reordered)).toBe(payloadHash(fields));
  });

  test('same idempotency key with a different payload is a conflict, not a replay', () => {
    const original = tx({ payloadHash: payloadHash(fields) });
    expect(original.matchesPayload(payloadHash(fields))).toBe(true);
    expect(original.matchesPayload(payloadHash({ ...fields, money: brl('25.01') }))).toBe(false);
  });

  test('hash is SHA-256 hex', () => {
    expect(payloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });
});
