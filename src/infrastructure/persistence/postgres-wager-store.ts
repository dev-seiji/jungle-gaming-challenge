import { LockMode, type MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateMessageError,
  DuplicateTransactionError,
  type StoredTransaction,
  type WagerStore,
  type WagerUnitOfWork,
  WalletAlreadyExistsError,
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
import { metrics } from '../observability/metrics';
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
    try {
      return await em.transactional(async (txEm) => {
        await txEm.execute(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        return work(new PostgresUnitOfWork(txEm));
      });
    } catch (error) {
      // Duas entregas da MESMA mensagem processadas ao mesmo tempo: a PK do inbox barrou a segunda
      // (e o rollback desfez tudo dela). Para o consumidor isso é "já processada": ack.
      if (error instanceof UniqueConstraintViolationException && error.message.includes('inbox_messages_pkey')) {
        throw new DuplicateMessageError(error.message);
      }
      throw error;
    }
  }
}

class PostgresUnitOfWork implements WagerUnitOfWork {
  // Records das wallets travadas: o Unit of Work rastreia mudanças neles e gera o UPDATE no flush.
  private readonly lockedWallets = new Map<string, WalletRecord>();
  private readonly claimedTransactions = new Map<string, WagerTransactionRecord>();

  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    // Gera SELECT ... FOR UPDATE. Lock de LINHA: só essa wallet espera; as outras seguem em paralelo.
    const startedAt = performance.now();
    let record: WalletRecord | null;
    try {
      record = await this.em.findOne(WalletRecord, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    } catch (error) {
      if ((error as { code?: string }).code === '55P03') metrics.lockTimeouts.inc(); // estourou o lock_timeout
      throw error;
    } finally {
      metrics.lockWait.observe((performance.now() - startedAt) / 1000);
    }
    if (!record) return undefined;
    this.lockedWallets.set(walletId, record);
    return toWallet(record);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<StoredTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { idempotencyKey });
    return record ? toStored(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<StoredTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? toStored(record) : undefined;
  }

  async isAlreadyReversed(referenceTransactionId: string): Promise<boolean> {
    // reference_transaction_id só é preenchido quando a reversão é PROCESSED.
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async findWalletByPlayer(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { playerId, currency });
    return record ? toWallet(record) : undefined;
  }

  async addWallet(wallet: Wallet): Promise<void> {
    this.em.persist(
      Object.assign(new WalletRecord(), {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }),
    );
    // Flush imediato: a OPENING e o ledger têm FK para a wallet, e a unique (player_id, currency)
    // é quem garante "uma wallet por jogador e moeda" mesmo com dois POST /wallets simultâneos.
    try {
      await this.em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException && error.message.includes('wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError(`player ${wallet.playerId} already has a ${wallet.currency} wallet`);
      }
      throw error;
    }
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

  async claimDuePendingReference(now: Date): Promise<WagerTransaction | undefined> {
    // SKIP LOCKED: outra instância do worker pula esta linha em vez de esperar — cada pendente é
    // reprocessada por um worker só de cada vez.
    const [record] = await this.em.find(
      WagerTransactionRecord,
      { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: 'asc' }, limit: 1, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    if (!record) return undefined;
    this.claimedTransactions.set(record.id, record);
    return toTransaction(record);
  }

  updateTransaction(transaction: WagerTransaction, observedBalance?: Money): void {
    const record = this.claimedTransactions.get(transaction.id);
    if (!record) throw new Error(`transaction ${transaction.id} must be claimed before being updated`);
    // Unit of Work: alterar o record gerenciado vira UPDATE no flush do commit.
    copyTransaction(record, transaction, observedBalance);
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
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
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
  return copyTransaction(new WagerTransactionRecord(), t, observedBalance);
}

/** Copia o estado do domínio para o record (novo ou já gerenciado pelo Unit of Work). */
function copyTransaction(record: WagerTransactionRecord, t: WagerTransaction, observedBalance?: Money): WagerTransactionRecord {
  return Object.assign(record, {
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
    referenceAttempts: t.referenceAttempts,
    nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
  });
}
