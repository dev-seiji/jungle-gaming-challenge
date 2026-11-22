import { LockMode, type MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateTransactionError,
  type StoredTransaction,
  type WagerStore,
  type WagerUnitOfWork,
} from '../../application/wager-store';
import type { FailureCode } from '../../domain/failure-code';
import type { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './records';

// Esperar lock de uma wallet "quente" por mais que isso vira falha transitória (o cliente reenvia),
// em vez de segurar conexões do pool indefinidamente.
const LOCK_TIMEOUT = '5s';

// Constraints que significam "essa mesma transação já foi criada por outra requisição concorrente".
const DUPLICATE_TX_CONSTRAINTS = /wager_tx_idempotency_key_uq|wager_tx_provider_external_uq/;

export class PostgresWagerStore implements WagerStore {
  constructor(private readonly orm: MikroORM) {}

  async transaction<T>(work: (uow: WagerUnitOfWork) => Promise<T>): Promise<T> {
    // fork(): Identity Map próprio para esta execução — nada de entidade "velha" vinda de outra requisição.
    const em = this.orm.em.fork() as EntityManager;
    // transactional(): BEGIN, roda o callback, faz flush (Unit of Work grava tudo) e COMMIT; erro = ROLLBACK.
    return em.transactional(async (txEm) => {
      await txEm.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      return work(new PostgresUnitOfWork(txEm));
    });
  }
}

class PostgresUnitOfWork implements WagerUnitOfWork {
  // Records das wallets travadas: o Unit of Work rastreia mudanças neles e gera o UPDATE no flush.
  private readonly lockedWallets = new Map<string, WalletRecord>();

  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    // Gera SELECT ... FOR UPDATE. Lock de LINHA: só essa wallet espera; as outras seguem em paralelo.
    const record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!record) return undefined;
    this.lockedWallets.set(walletId, record);
    return toWallet(record);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { idempotencyKey });
    return record ? toStored(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toTransaction(record) : undefined;
  }

  async isAlreadyReversed(referenceTransactionId: string): Promise<boolean> {
    // reference_transaction_id só é preenchido quando a reversão é PROCESSED.
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async addTransaction(transaction: WagerTransaction, observedBalance?: Money): Promise<void> {
    this.em.persist(toTransactionRecord(transaction, observedBalance));
    // Flush imediato: (1) o lançamento do ledger tem FK para esta linha; (2) se outra requisição
    // concorrente já criou a mesma transação, a unique constraint aparece aqui e vira DuplicateTransactionError.
    try {
      await this.em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && DUPLICATE_TX_CONSTRAINTS.test(error.message)) {
        throw new DuplicateTransactionError(error.message);
      }
      throw error;
    }
  }

  saveWallet(wallet: Wallet): void {
    const record = this.lockedWallets.get(wallet.id);
    if (!record) throw new Error(`wallet ${wallet.id} must be locked before being saved`);
    record.balance = wallet.balance.toJSON().amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
  }

  addLedgerEntry(entry: WalletLedgerEntry): void {
    this.em.persist(
      Object.assign(new LedgerEntryRecord(), {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      }),
    );
  }

  addOutbox(message: OutboxMessage): void {
    this.em.persist(
      Object.assign(new OutboxRecord(), {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload,
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      }),
    );
  }

  addInbox(message: InboxMessage): void {
    this.em.persist(
      Object.assign(new InboxRecord(), {
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      }),
    );
  }
}

// ---- conversão record <-> domínio (rehydrate: reconstrói estado persistido, não revalida transições)

function toWallet(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: Money.from({ amount: r.balance, currency: r.currency }),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

function toTransaction(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: Money.from({ amount: r.amount, currency: r.currency }),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: r.processedAt ?? undefined,
  });
}

function toStored(r: WagerTransactionRecord): StoredTransaction {
  const observedBalance =
    r.observedBalanceAmount && r.observedBalanceCurrency
      ? Money.from({ amount: r.observedBalanceAmount, currency: r.observedBalanceCurrency })
      : undefined;
  return { transaction: toTransaction(r), observedBalance };
}

function toTransactionRecord(t: WagerTransaction, observedBalance?: Money): WagerTransactionRecord {
  return Object.assign(new WagerTransactionRecord(), {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    amount: t.money.toJSON().amount,
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    status: t.status,
    failureCode: t.failureCode ?? null,
    createdAt: t.createdAt,
    processedAt: t.processedAt ?? null,
    observedBalanceAmount: observedBalance?.toJSON().amount ?? null,
    observedBalanceCurrency: observedBalance?.currency ?? null,
  });
}
