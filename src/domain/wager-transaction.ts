import { InvalidInputError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL = [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed];

// Que tipo de transação cada operação pode referenciar (regra 3 do enunciado).
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'id' | 'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt' | 'referenceAttempts' | 'nextReferenceAttemptAt'
>;

// Reprocessamento de PENDING_REFERENCE: espera 5s, 10s, 20s ... 640s entre as tentativas (8 no total, ~21 min).
// Referência fora de ordem costuma chegar em segundos; 21 min cobre até um lote atrasado do provedor.
// Depois disso o provedor precisa de resposta definitiva (REFERENCE_NOT_FOUND), não de algo pendurado.
export const MAX_REFERENCE_ATTEMPTS = 8;
const REFERENCE_RETRY_BASE_MS = 5_000;

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceAttempts = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida o que vem do provedor (API ou fila). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidInputError('OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidInputError(`unknown kind: ${props.kind}`);
    }
    // Ganhar ou apostar 0 não existe; empate chega como WIN com valor > 0.
    if (!props.money.isPositive()) throw new InvalidInputError('amount must be greater than zero');

    const hasReference = !!props.referenceExternalTransactionId;
    const requiresReference = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(props.kind);
    if (requiresReference && !hasReference) {
      throw new InvalidInputError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (hasReference && !ALLOWED_REFERENCE_KINDS[props.kind]) {
      throw new InvalidInputError(`${props.kind} cannot reference another transaction`);
    }

    return WagerTransaction.rehydrate({ ...props, id: Bun.randomUUIDv7(), status: WagerTransactionStatus.Pending });
  }

  /**
   * Transação interna de abertura da wallet (nunca vem do provedor).
   * Chaves determinísticas por wallet: "internal" não colide com provider real e a abertura é única.
   */
  static opening(props: {
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) throw new InvalidInputError('opening amount must be greater than zero');
    return WagerTransaction.rehydrate({
      id: Bun.randomUUIDv7(),
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
    });
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.processedAt,
      s.referenceAttempts ?? 0,
      s.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições
  // PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
  // PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
  // PROCESSED, REJECTED, FAILED são terminais.

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  /** Referência ainda não chegou: espera e agenda a 1ª nova tentativa do worker. */
  markPendingReference(now: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference not allowed from ${this._status}`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = new Date(now.getTime() + REFERENCE_RETRY_BASE_MS);
  }

  /**
   * O worker tentou de novo e a referência continua ausente. Agenda a próxima com backoff exponencial
   * ou devolve 'exhausted' quando acabaram as tentativas (aí o caller rejeita com REFERENCE_NOT_FOUND).
   */
  registerFailedReferenceAttempt(now: Date): 'retry' | 'exhausted' {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`registerFailedReferenceAttempt not allowed from ${this._status}`);
    }
    this._referenceAttempts += 1;
    if (this._referenceAttempts >= MAX_REFERENCE_ATTEMPTS) return 'exhausted';
    this._nextReferenceAttemptAt = new Date(now.getTime() + REFERENCE_RETRY_BASE_MS * 2 ** this._referenceAttempts);
    return 'retry';
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Mesma idempotency key com hash diferente é conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK é o inverso da referência; LOSS não gera lançamento. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new Error('ROLLBACK needs its reference to know the direction');
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new Error('LOSS does not move balance and has no ledger direction');
    }
  }

  /**
   * Valida a referência já encontrada (regras 2, 3 e 5 do enunciado).
   * Devolve o failureCode da rejeição, ou undefined se a referência é válida.
   * "Já revertida" não é checado aqui: quem garante é a unique constraint no banco (Fase 3).
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    const sameOwner =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId;
    if (!sameOwner) return FailureCode.ReferenceMismatch;
    if (reference.money.currency !== this.money.currency) return FailureCode.CurrencyMismatch;
    if (!ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind)) return FailureCode.InvalidReferenceKind;
    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;
    if (this.requiresReference() && !reference.money.equals(this.money)) return FailureCode.AmountMismatch;
    return undefined;
  }

  /** Mesmo "saldo insuficiente" tem significados diferentes: aposta sem saldo x reversão de crédito já gasto. */
  insufficientBalanceCode(): FailureCode {
    return this.kind === WagerTransactionKind.Rollback
      ? FailureCode.ReversalWouldOverdraw
      : FailureCode.InsufficientFunds;
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${action} not allowed: transaction ${this.id} is already ${this._status}`);
    }
  }
}
