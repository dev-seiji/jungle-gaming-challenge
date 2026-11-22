import type { InboxMessage } from '../domain/inbox-message';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

// Porta: o que o caso de uso precisa da persistência, em termos de domínio.
// A implementação (adaptador) é PostgresWagerStore; o caso de uso não conhece SQL nem MikroORM.

export interface StoredTransaction {
  transaction: WagerTransaction;
  /** Saldo observado quando a transação foi decidida (regra 7: o replay devolve esse valor). */
  observedBalance?: Money;
}

/** Tudo que acontece dentro de UMA transação SQL. */
export interface WagerUnitOfWork {
  /** SELECT ... FOR UPDATE: segura a wallet até o commit. Outras wallets não são afetadas. */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<StoredTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<StoredTransaction | undefined>;
  /** A referência já tem uma reversão (REFUND/ROLLBACK) aplicada? */
  isAlreadyReversed(referenceTransactionId: string): Promise<boolean>;

  /** Lança WalletAlreadyExistsError se já existe wallet para (playerId, currency). */
  addWallet(wallet: Wallet): Promise<void>;
  addTransaction(transaction: WagerTransaction, observedBalance?: Money): Promise<void>;
  saveWallet(wallet: Wallet): void;
  addLedgerEntry(entry: WalletLedgerEntry): void;
  addOutbox(message: OutboxMessage): void;
  addInbox(message: InboxMessage): void;
}

export interface WagerStore {
  /** Abre a transação SQL, roda `work` e faz commit; qualquer erro faz rollback de tudo. */
  transaction<T>(work: (uow: WagerUnitOfWork) => Promise<T>): Promise<T>;
}

/** Duas requisições criaram a mesma transação ao mesmo tempo; quem perdeu deve repetir e virar replay. */
export class DuplicateTransactionError extends Error {
  override name = 'DuplicateTransactionError';
}

/** Já existe wallet para esse jogador nessa moeda (unique no banco). */
export class WalletAlreadyExistsError extends Error {
  override name = 'WalletAlreadyExistsError';
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com conteúdo diferente: conflito, não replay. */
export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}
