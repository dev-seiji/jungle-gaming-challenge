// Helpers dos testes de integração (Postgres real do compose).
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';
import type { ProcessWagerCommand } from '../../src/application/process-wager-transaction';

export async function initOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init({ ...config, pool: { min: 2, max: 60 } }); // pool grande: testes com 50 em paralelo
  await orm.migrator.up();
  return orm;
}

const sql = (orm: MikroORM, query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute(query, params);

/**
 * Cria a wallet do jeito que a Fase 4 vai criar: wallet + transação OPENING + lançamento CREDIT, para que
 * o invariante "saldo == ledger" valha desde o início. (A Fase 4 troca isto pelo caso de uso CreateWallet.)
 */
export async function createWallet(orm: MikroORM, balance = '100.00', currency = 'BRL') {
  const walletId = Bun.randomUUIDv7();
  const playerId = Bun.randomUUIDv7();
  const openingId = Bun.randomUUIDv7();
  await sql(orm, `INSERT INTO wallets VALUES (?, ?, ?, ?, 1, now(), now())`, [walletId, playerId, currency, balance]);
  if (balance !== '0.00') {
    await sql(
      orm,
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at)
       VALUES (?, 'internal', ?, ?, ?, ?, ?, 'opening', 'opening', 'OPENING', ?, ?, 'PROCESSED', now(), now())`,
      [openingId, `opening:${walletId}`, `internal:opening:${walletId}`, '0'.repeat(64), walletId, playerId, balance, currency],
    );
    await sql(
      orm,
      `INSERT INTO wallet_ledger_entries VALUES (?, ?, ?, 'CREDIT', ?, ?, 0, ?, now())`,
      [Bun.randomUUIDv7(), walletId, openingId, balance, currency, balance],
    );
  }
  return { walletId, playerId };
}

export async function walletRow(orm: MikroORM, walletId: string) {
  const [row] = await sql(orm, `SELECT balance, version FROM wallets WHERE id = ?`, [walletId]);
  return row as { balance: string; version: number };
}

/** Invariante final de todos os testes: saldo materializado == saldo reconstruído somando o ledger. */
export async function expectBalanceMatchesLedger(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await sql(
    orm,
    `SELECT w.balance,
            COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2) AS ledger
       FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
      WHERE w.id = ? GROUP BY w.balance`,
    [walletId],
  );
  if (row.balance !== row.ledger) throw new Error(`wallet ${walletId}: balance ${row.balance} != ledger ${row.ledger}`);
  return row.balance as string;
}

export async function ledgerEntries(orm: MikroORM, walletId: string) {
  return (await sql(
    orm,
    `SELECT l.direction, l.amount, t.kind FROM wallet_ledger_entries l
       JOIN wager_transactions t ON t.id = l.transaction_id
      WHERE l.wallet_id = ? AND t.kind <> 'OPENING' ORDER BY l.id`,
    [walletId],
  )) as { direction: string; amount: string; kind: string }[];
}

export async function outboxEventTypes(orm: MikroORM, aggregateIds: string[]) {
  const rows = await sql(
    orm,
    `SELECT event_type FROM outbox_messages WHERE aggregate_id IN (${aggregateIds.map(() => '?').join(', ')}) ORDER BY id`,
    aggregateIds,
  );
  return rows.map((r) => r.event_type as string);
}

export async function countRows(orm: MikroORM, table: string, where: string, params: unknown[]) {
  const [row] = await sql(orm, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return row.n as number;
}

/** Comando de BET padrão para uma wallet; sobrescreva o que precisar. */
export function command(
  wallet: { walletId: string; playerId: string },
  overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Bun.randomUUIDv7()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}
