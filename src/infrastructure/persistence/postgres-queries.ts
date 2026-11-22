import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { InvalidInputError } from '../../domain/errors';
import type { MoneyProps } from '../../domain/money';
import { isUuid } from '../../domain/uuid';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

// Consultas só de leitura (não passam pelo domínio: não mudam estado, só montam a resposta).

export const MAX_PAGE_SIZE = 100;

const money = (amount: string, currency: string): MoneyProps => ({ amount, currency });

export class PostgresQueries {
  constructor(private readonly orm: MikroORM) {}

  private em(): EntityManager {
    return this.orm.em.fork() as EntityManager;
  }

  async getWallet(walletId: string) {
    if (!isUuid(walletId)) return undefined; // id malformado = não existe (evita erro de SQL)
    const w = await this.em().findOne(WalletRecord, { id: walletId });
    return w && { id: w.id, playerId: w.playerId, balance: money(w.balance, w.currency), version: w.version };
  }

  /**
   * Extrato paginado por cursor. O cursor é o id do último item visto, codificado (opaco para o cliente).
   * Estável: o id é UUIDv7 (cresce com o tempo) e o ledger é append-only, então lançamentos novos
   * entram sempre no FIM — nunca deslocam páginas já lidas (diferente de OFFSET).
   */
  async ledgerPage(walletId: string, cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new InvalidInputError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    const afterId = cursor === undefined ? undefined : decodeCursor(cursor);
    if (!(await this.getWallet(walletId))) return undefined;

    const rows = await this.em().find(
      LedgerEntryRecord,
      { walletId, ...(afterId ? { id: { $gt: afterId } } : {}) },
      { orderBy: { id: 'asc' }, limit: limit + 1 }, // +1: descobre se existe próxima página sem COUNT
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: money(e.amount, e.currency),
        balanceBefore: money(e.balanceBefore, e.currency),
        balanceAfter: money(e.balanceAfter, e.currency),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null,
    };
  }

  async getTransaction(transactionId: string) {
    if (!isUuid(transactionId)) return undefined;
    const t = await this.em().findOne(WagerTransactionRecord, { id: transactionId });
    return t ? transactionView(t) : undefined;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string) {
    const t = await this.em().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return t ? transactionView(t) : undefined;
  }

  /** Saldo gravado x saldo reconstruído pelo ledger. Não corrige nada: só mede e reporta. */
  async reconcile(walletId: string) {
    if (!isUuid(walletId)) return undefined;
    const [row] = await this.em().execute(
      `SELECT w.currency, w.balance AS stored,
              COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2) AS calculated,
              (w.balance - COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0))::numeric(20,2) AS difference,
              COUNT(l.id)::int AS checked
         FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );
    if (!row) return undefined;
    return {
      walletId,
      storedBalance: money(row.stored, row.currency),
      calculatedBalance: money(row.calculated, row.currency),
      difference: money(row.difference, row.currency),
      consistent: row.stored === row.calculated,
      checkedEntries: row.checked as number,
    };
  }
}

function transactionView(t: WagerTransactionRecord) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: money(t.amount, t.currency),
    status: t.status,
    failureCode: t.failureCode ?? undefined,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: t.referenceTransactionId ?? undefined,
    balance:
      t.observedBalanceAmount && t.observedBalanceCurrency
        ? money(t.observedBalanceAmount, t.observedBalanceCurrency)
        : undefined,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString(),
  };
}

const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString();
  if (!isUuid(id)) throw new InvalidInputError('invalid cursor');
  return id;
}
