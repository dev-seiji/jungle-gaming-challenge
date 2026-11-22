import { CurrencyMismatchError, InsufficientBalanceError, InvalidInputError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version 1.
   * Saldo inicial > 0 precisa de lançamento no ledger (toda alteração de saldo tem lançamento),
   * por isso devolve também o lançamento de abertura, ligado à transação OPENING.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    /** Obrigatório quando o saldo inicial é > 0 (id da transação OPENING). */
    openingTransactionId?: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative()) throw new InvalidInputError('initial balance cannot be negative');
    const { initialBalance: balance, at } = props;
    const wallet = new Wallet(props.id, props.playerId, balance.currency, balance, 1, at, at);
    if (balance.isZero()) return { wallet };
    if (!props.openingTransactionId) throw new Error('a positive initial balance needs an OPENING transaction id');
    const openingEntry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: balance,
      balanceBefore: Money.zero(balance.currency),
      balanceAfter: balance,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida nada. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Lança InsufficientBalanceError sem alterar nada se o saldo ficaria negativo. */
  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    const after = this._balance.subtract(money);
    if (after.isNegative()) {
      throw new InsufficientBalanceError(`balance ${this._balance} is not enough for ${money}`);
    }
    return this.apply(LedgerDirection.Debit, money, after, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.apply(LedgerDirection.Credit, money, this._balance.add(money), transactionId, at);
  }

  // Saldo e ledger mudam juntos, num lugar só: o lançamento é criado (e validado) antes de mexer no saldo.
  private apply(
    direction: LedgerDirection,
    money: Money,
    after: Money,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet is ${this.currency}, operation is ${money.currency}`);
    }
  }
}
