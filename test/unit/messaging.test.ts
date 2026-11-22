import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletBalanceChanged } from '../../src/domain/events';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { InboxMessage } from '../../src/domain/inbox-message';
import { InvalidTransactionStateError } from '../../src/domain/errors';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const at = new Date('2026-11-22T12:00:00.000Z');
const ctx = { correlationId: 'corr-1', occurredAt: at };

function balanceChanged() {
  const { wallet } = Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: 'open',
    at,
  });
  const entry = wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), 'tx-1', at);
  return WalletBalanceChanged.from(wallet, entry, ctx);
}

describe('IntegrationEvent', () => {
  test('eventType and version come from the subclass; data carries MoneyProps strings, not Money', () => {
    const json = balanceChanged().toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe('w1');
    expect(json.occurredAt).toBe('2026-11-22T12:00:00.000Z');
    expect(json.data).toEqual({
      walletId: 'w1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    // payload precisa sobreviver a ida e volta por JSON (é o que vai para a outbox e para o SQS)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('OutboxMessage', () => {
  test('enqueue uses the eventId as id and is due immediately', () => {
    const event = balanceChanged();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(at)).toBe(true);
  });

  test('scheduleRetry backs off exponentially, capped at 5 minutes', () => {
    const msg = OutboxMessage.enqueue(balanceChanged());
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      msg.scheduleRetry(at);
      delays.push(msg.nextAttemptAt!.getTime() - at.getTime());
    }
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(Math.max(...delays)).toBe(300_000);
    expect(msg.attempts).toBe(12);
    expect(msg.isDue(at)).toBe(false);
    expect(msg.isDue(new Date(at.getTime() + 300_000))).toBe(true);
  });

  test('published message is no longer pending nor due, and cannot be published twice', () => {
    const msg = OutboxMessage.enqueue(balanceChanged());
    msg.markPublished(at);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(at)).toBe(false);
    expect(() => msg.markPublished(at)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed once', () => {
    const msg = InboxMessage.receive({ messageId: 'm1', consumerName: 'wager', payloadHash: 'h', receivedAt: at });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(at);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(at)).toThrow(InvalidTransactionStateError);
  });
});
