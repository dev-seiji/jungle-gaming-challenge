import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { CurrencyMismatchError, InvalidInputError } from '../../src/domain/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from (input contract)', () => {
  test('accepts exactly 2 decimal places and round-trips the same string', () => {
    for (const amount of ['0.00', '0.30', '25.00', '999999999999999999.99']) {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    }
  });

  test.each([
    ['empty string', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['scientific notation', '1e5'],
    ['scientific notation with places', '1.00e2'],
    ['negative', '-1.00'],
    ['no decimal places', '25'],
    ['1 decimal place', '25.5'],
    ['1 decimal place zero', '0.0'],
    ['3 decimal places (never rounded)', '1.005'],
    ['comma separator', '0,30'],
    ['whitespace', ' 1.00'],
    ['more than 18 integer digits (does not fit NUMERIC(20,2))', '1000000000000000000.00'],
  ])('rejects %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidInputError);
  });

  test('rejects a number instead of a string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidInputError);
  });

  test.each(['brl', 'BR', 'REAL', ''])('rejects invalid currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidInputError);
  });
});

describe('Money arithmetic', () => {
  test('is exact where binary floating point is not (0.10 + 0.20)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test('keeps full precision on very large values (no silent rounding)', () => {
    const big = brl('999999999999999999.99');
    expect(big.add(big).toJSON().amount).toBe('1999999999999999999.98');
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
  });

  test('subtract can go negative internally, negate flips sign', () => {
    const r = brl('10.00').subtract(brl('10.01'));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe('-0.01');
    expect(r.negate().toJSON().amount).toBe('0.01');
  });

  test('zero is neither positive nor negative', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('operations between different currencies throw', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('toString', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});
