import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidInputError } from './errors';

// Cópia isolada do Decimal com precisão folgada: a padrão (20 dígitos significativos) arredondaria
// em silêncio a soma de dois valores grandes. 40 dígitos cobre com sobra NUMERIC(20,2).
const D = Decimal.clone({ precision: 40 });

// Só dígitos, ponto e exatamente 2 casas. Com isso ficam de fora, sem precisar de casos especiais:
// NaN, Infinity, notação científica, string vazia, negativos, vírgula e mais de 2 casas (nunca arredondamos).
// Até 18 dígitos inteiros = cabe em NUMERIC(20,2) no banco.
const AMOUNT_FORMAT = /^\d{1,18}\.\d{2}$/;
const CURRENCY_FORMAT = /^[A-Z]{3}$/; // ISO-4217

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: valida formato e rejeita negativos. */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string' || !AMOUNT_FORMAT.test(props.amount)) {
      throw new InvalidInputError(`invalid amount: expected a decimal string with exactly 2 places, like "25.00"`);
    }
    if (typeof props.currency !== 'string' || !CURRENCY_FORMAT.test(props.currency)) {
      throw new InvalidInputError(`invalid currency: expected an ISO-4217 code, like "BRL"`);
    }
    return new Money(new D(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.neg(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  // gt(0) e não isPositive(): no decimal.js, isPositive() é true para zero.
  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}
