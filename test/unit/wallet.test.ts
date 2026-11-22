import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { CurrencyMismatchError, InsufficientBalanceError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-22T12:00:00Z');

function openWallet(initial: string) {
  return Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl(initial), openingTransactionId: 'tx-open', at });
}

/** Invariante final pedido pelo enunciado: saldo == saldo reconstruído pelo ledger. */
function ledgerBalance(entries: WalletLedgerEntry[]): Money {
  return entries.reduce(
    (sum, e) => (e.direction === LedgerDirection.Credit ? sum.add(e.money) : sum.subtract(e.money)),
    Money.zero('BRL'),
  );
}

describe('Wallet.open', () => {
  test('starts at version 1 with the initial balance and an opening CREDIT entry', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe('tx-open');
    expect(ledgerBalance([openingEntry!]).equals(wallet.balance)).toBe(true);
  });

  test('zero initial balance opens without a ledger entry', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), openingTransactionId: 't', at }),
    ).toThrow();
  });
});

describe('Wallet debit/credit', () => {
  test('debit and credit move balance, bump version and return the matching ledger entry', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const bet = wallet.debit(brl('80.00'), 'tx-bet', at);
    const win = wallet.credit(brl('30.00'), 'tx-win', at);

    expect(wallet.balance.equals(brl('50.00'))).toBe(true);
    expect(wallet.version).toBe(3);
    expect(bet.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(bet.balanceAfter.equals(brl('20.00'))).toBe(true);
    expect(win.balanceAfter.equals(brl('50.00'))).toBe(true);
    expect(ledgerBalance([openingEntry!, bet, win]).equals(wallet.balance)).toBe(true);
  });

  test('debit of exactly the whole balance leaves zero (allowed)', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(brl('80.00'), 'tx', at);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('scenario of the challenge, in sequence: 100.00, two bets of 80.00 → second one fails and changes nothing', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(brl('80.00'), 'tx-1', at);
    expect(() => wallet.debit(brl('80.00'), 'tx-2', at)).toThrow(InsufficientBalanceError);
    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2); // falha não muda versão
  });

  test('operation in another currency throws and changes nothing', () => {
    const { wallet } = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, 'tx', at)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, 'tx', at)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('zero amount is refused by the ledger and changes nothing', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.credit(brl('0.00'), 'tx', at)).toThrow();
    expect(wallet.version).toBe(1);
  });
});

describe('WalletLedgerEntry', () => {
  const base = { walletId: 'w', transactionId: 't', createdAt: at };

  test('create checks before ± amount = after', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('95.00'),
      }),
    ).toThrow(/not balanced/);
  });

  test('create refuses an entry that leaves a negative balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(/negative/);
  });

  test('is structurally immutable (frozen)', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('10.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { money: Money }).money = brl('999.00');
    }).toThrow();
  });
});
