import { InsufficientBalanceError, InvalidInputError } from '../domain/errors';
import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { payloadHash } from '../domain/payload-hash';
import { isUuid } from '../domain/uuid';
import { WagerTransaction, type WagerTransactionKind, type WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { LedgerDirection } from '../domain/wallet-ledger-entry';
import {
  DuplicateTransactionError,
  IdempotencyConflictError,
  type StoredTransaction,
  type WagerStore,
  type WagerUnitOfWork,
} from './wager-store';

/** Entrada comum do HTTP e da fila. */
export interface ProcessWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessContext {
  correlationId: string;
  causationId?: string;
  /** Presente quando a entrada veio da fila: o registro de inbox entra na mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string };
}

export interface ProcessResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export class ProcessWagerTransaction {
  constructor(private readonly store: WagerStore) {}

  async execute(command: ProcessWagerCommand, ctx: ProcessContext): Promise<ProcessResult> {
    // Valida a entrada antes de abrir transação: erro de formato não gasta lock nem conexão.
    const build = () => this.buildTransaction(command);
    build();
    try {
      return await this.store.transaction((uow) => this.process(uow, build(), ctx));
    } catch (error) {
      // Duas cópias da mesma requisição sem wallet para travar (ex.: WALLET_NOT_FOUND) correram juntas
      // e a unique constraint barrou a segunda. Repetindo uma vez, ela encontra a primeira e vira replay.
      if (error instanceof DuplicateTransactionError) {
        return this.store.transaction((uow) => this.process(uow, build(), ctx));
      }
      throw error;
    }
  }

  private buildTransaction(command: ProcessWagerCommand): WagerTransaction {
    // walletId é id interno (uuid no banco): sem isso, um id malformado viraria erro de SQL em vez de 400.
    if (!isUuid(command.walletId)) throw new InvalidInputError('walletId must be a UUID');
    const money = Money.from(command.money);
    // Hash só dos campos de negócio (sem idempotencyKey, que é a própria chave, nem metadados de transporte).
    // Money normalizado via toJSON: "025.00" e "25.00" são o mesmo valor.
    const hash = payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });
    return WagerTransaction.create({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: new Date(),
    });
  }

  private async process(uow: WagerUnitOfWork, tx: WagerTransaction, ctx: ProcessContext): Promise<ProcessResult> {
    const at = tx.createdAt;
    const eventCtx: EventContext = { correlationId: ctx.correlationId, causationId: ctx.causationId, occurredAt: at };
    if (ctx.inbox) {
      const inbox = InboxMessage.receive({ ...ctx.inbox, payloadHash: tx.payloadHash, receivedAt: at });
      inbox.markProcessed(at); // gravado no mesmo commit do efeito: se o commit falhar, a mensagem não conta como vista
      uow.addInbox(inbox);
    }

    // 1) Lock primeiro. Todas as operações dessa wallet passam a esperar em fila aqui, inclusive
    //    cópias da MESMA requisição: quando a segunda passar do lock, a primeira já fez commit.
    const wallet = await uow.lockWallet(tx.walletId);

    // 2) Idempotência, checada DEPOIS do lock (antes dele, duas cópias concorrentes não veriam uma à outra).
    //    Busca pela key OU pelo id externo. Sem lock (wallet inexistente), uma cópia concorrente pode fazer
    //    commit ENTRE as duas consultas (cada SELECT vê os commits feitos até ele): por isso, achar pelo id
    //    externo com a MESMA key ainda é a mesma transação (replay); só key diferente é conflito.
    const existing =
      (await uow.findByIdempotencyKey(tx.idempotencyKey)) ??
      (await uow.findByExternalId(tx.providerId, tx.externalTransactionId));
    if (existing) {
      if (existing.transaction.idempotencyKey !== tx.idempotencyKey) {
        throw new IdempotencyConflictError(
          `externalTransactionId ${tx.externalTransactionId} was already used with another idempotency key`,
        );
      }
      if (!existing.transaction.matchesPayload(tx.payloadHash)) {
        throw new IdempotencyConflictError(`idempotency key ${tx.idempotencyKey} was used with a different payload`);
      }
      return replay(existing);
    }

    // 3) Regras que não dependem de saldo.
    if (!wallet) return this.reject(uow, tx, FailureCode.WalletNotFound, undefined, eventCtx);
    if (wallet.playerId !== tx.playerId) return this.reject(uow, tx, FailureCode.WalletPlayerMismatch, wallet, eventCtx);
    if (wallet.currency !== tx.money.currency) return this.reject(uow, tx, FailureCode.CurrencyMismatch, wallet, eventCtx);

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      reference = (await uow.findByExternalId(tx.providerId, tx.referenceExternalTransactionId))?.transaction;
      // Referência ainda não chegou (ou chegou e ainda não foi decidida): espera, não rejeita (regra 8).
      if (!reference || !reference.isTerminal()) {
        tx.markPendingReference();
        await uow.addTransaction(tx, wallet.balance);
        this.publish(uow, WagerTransactionPendingReference.from(tx, eventCtx));
        return result(tx, wallet.balance);
      }
      const code = tx.checkReference(reference);
      if (code) return this.reject(uow, tx, code, wallet, eventCtx);
      // Seguro contra corrida porque estamos com o lock da wallet (a referência é da mesma wallet).
      // Mesmo assim o índice único wager_tx_single_reversal_uq continua como última barreira.
      if (tx.requiresReference() && (await uow.isAlreadyReversed(reference.id))) {
        return this.reject(uow, tx, FailureCode.AlreadyReversed, wallet, eventCtx);
      }
    }

    // 4) LOSS: registra o resultado sem mover saldo, sem ledger, sem WalletBalanceChanged.
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, at);
      await uow.addTransaction(tx, wallet.balance);
      this.publish(uow, WagerTransactionProcessed.from(tx, wallet, eventCtx));
      return result(tx, wallet.balance);
    }

    // 5) Movimenta o saldo. Wallet garante: saldo + version + lançamento mudam juntos ou nada muda.
    let entry;
    try {
      entry =
        tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(tx.money, tx.id, at)
          : wallet.credit(tx.money, tx.id, at);
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        return this.reject(uow, tx, tx.insufficientBalanceCode(), wallet, eventCtx);
      }
      throw error;
    }

    tx.markProcessed(reference?.id, at);
    await uow.addTransaction(tx, wallet.balance); // antes do ledger: o lançamento tem FK para a transação
    uow.saveWallet(wallet);
    uow.addLedgerEntry(entry);
    this.publish(uow, WagerTransactionProcessed.from(tx, wallet, eventCtx));
    this.publish(uow, WalletBalanceChanged.from(wallet, entry, eventCtx));
    return result(tx, wallet.balance);
  }

  /** Rejeição de negócio: grava a transação REJECTED (key "queimada") + evento. Saldo e ledger intactos. */
  private async reject(
    uow: WagerUnitOfWork,
    tx: WagerTransaction,
    code: FailureCode,
    wallet: Wallet | undefined,
    eventCtx: EventContext,
  ): Promise<ProcessResult> {
    tx.reject(code);
    await uow.addTransaction(tx, wallet?.balance);
    this.publish(uow, WagerTransactionRejected.from(tx, eventCtx));
    return result(tx, wallet?.balance);
  }

  // Evento vai para a outbox, na mesma transação SQL. Publicar no SQS só depois do commit (Fase 5).
  private publish(uow: WagerUnitOfWork, event: IntegrationEvent<unknown>): void {
    uow.addOutbox(OutboxMessage.enqueue(event));
  }
}

function result(tx: WagerTransaction, balance: Money | undefined, idempotentReplay = false): ProcessResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

function replay(stored: StoredTransaction): ProcessResult {
  return result(stored.transaction, stored.observedBalance, true);
}
