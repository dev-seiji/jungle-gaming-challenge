// Integração real contra o Postgres do compose (precisa de `docker compose up -d postgres` e do .env).
// Cada teste tenta violar uma garantia e confere que o BANCO recusa, com o código SQLSTATE e o nome da constraint.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config';

// SQLSTATE do Postgres
const UNIQUE = '23505';
const CHECK = '23514';
const FOREIGN_KEY = '23503';
const RAISED = 'P0001'; // RAISE EXCEPTION do trigger

let orm: MikroORM;
const sql = (query: string, params: unknown[] = []) => orm.em.getConnection().execute(query, params);
const id = () => Bun.randomUUIDv7();

async function expectRefused(action: Promise<unknown>, sqlState: string, name: string) {
  const error = await action.then(
    () => undefined,
    (e: { code?: string; message: string }) => e,
  );
  expect(error).toBeDefined();
  expect(error!.code).toBe(sqlState);
  expect(error!.message).toContain(name);
}

async function insertWallet(o: { id?: string; playerId?: string; currency?: string; balance?: string; version?: number } = {}) {
  const walletId = o.id ?? id();
  await sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, now(), now())`,
    [walletId, o.playerId ?? id(), o.currency ?? 'BRL', o.balance ?? '100.00', o.version ?? 1],
  );
  return walletId;
}

interface TxOverrides {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  walletId?: string;
  kind?: string;
  amount?: string;
  status?: string;
  failureCode?: string | null;
  processedAt?: string | null;
  referenceExternalId?: string | null;
  referenceId?: string | null;
}

async function insertTx(o: TxOverrides = {}) {
  const txId = o.id ?? id();
  const externalId = o.externalId ?? `ext-${txId}`;
  await sql(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency,
       reference_external_transaction_id, reference_transaction_id, status, failure_code, created_at, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'player', 'round-1', 'game', ?, ?, 'BRL', ?, ?, ?, ?, now(), ?)`,
    [
      txId,
      o.providerId ?? 'provider-a',
      externalId,
      o.idempotencyKey ?? `provider-a:${externalId}`,
      'a'.repeat(64),
      o.walletId ?? id(),
      o.kind ?? 'BET',
      o.amount ?? '10.00',
      o.referenceExternalId ?? null,
      o.referenceId ?? null,
      o.status ?? 'PENDING',
      o.failureCode ?? null,
      o.processedAt === undefined ? null : o.processedAt,
    ],
  );
  return txId;
}

async function insertLedger(o: {
  walletId: string;
  transactionId: string;
  direction?: string;
  amount?: string;
  currency?: string;
  before?: string;
  after?: string;
}) {
  const entryId = id();
  await sql(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
       balance_before, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      entryId,
      o.walletId,
      o.transactionId,
      o.direction ?? 'DEBIT',
      o.amount ?? '10.00',
      o.currency ?? 'BRL',
      o.before ?? '100.00',
      o.after ?? '90.00',
    ],
  );
  return entryId;
}

const tableExists = async (table: string) =>
  (await sql(`SELECT to_regclass(?) AS t`, [`public.${table}`]))[0].t !== null;

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  await orm.close(true);
});

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];

describe('migrations', () => {
  // Atenção: este teste derruba e recria o schema (apaga os dados do banco de desenvolvimento).
  test('down removes every table and up creates them again', async () => {
    await orm.migrator.down({ to: 0 });
    for (const t of TABLES) expect(await tableExists(t)).toBe(false);

    await orm.migrator.up();
    for (const t of TABLES) expect(await tableExists(t)).toBe(true);
  });
});

describe('wallets', () => {
  test('one wallet per (player, currency); another currency for the same player is fine', async () => {
    const playerId = id();
    await insertWallet({ playerId, currency: 'BRL' });
    await insertWallet({ playerId, currency: 'USD' });
    await expectRefused(insertWallet({ playerId, currency: 'BRL' }), UNIQUE, 'wallets_player_currency_uq');
  });

  test('balance can be zero but never negative', async () => {
    await insertWallet({ balance: '0.00' });
    await expectRefused(insertWallet({ balance: '-0.01' }), CHECK, 'wallets_balance_non_negative');
  });

  test('a direct UPDATE cannot make the balance negative either', async () => {
    const walletId = await insertWallet({ balance: '10.00' });
    await expectRefused(
      sql(`UPDATE wallets SET balance = balance - 10.01 WHERE id = ?`, [walletId]),
      CHECK,
      'wallets_balance_non_negative',
    );
  });

  test('version starts at 1 or more', async () => {
    await expectRefused(insertWallet({ version: 0 }), CHECK, 'wallets_version_positive');
  });
});

describe('wager_transactions', () => {
  test('unique (provider_id, external_transaction_id); same external id from another provider is fine', async () => {
    await insertTx({ externalId: 'shared-ext', idempotencyKey: 'k1' });
    await insertTx({ externalId: 'shared-ext', providerId: 'provider-b', idempotencyKey: 'k2' });
    await expectRefused(insertTx({ externalId: 'shared-ext', idempotencyKey: 'k3' }), UNIQUE, 'wager_tx_provider_external_uq');
  });

  test('unique idempotency_key', async () => {
    const key = `key-${id()}`;
    await insertTx({ idempotencyKey: key });
    await expectRefused(insertTx({ idempotencyKey: key }), UNIQUE, 'wager_tx_idempotency_key_uq');
  });

  test('amount must be greater than zero', async () => {
    await expectRefused(insertTx({ amount: '0.00' }), CHECK, 'wager_tx_amount_positive');
  });

  test('kind and status are restricted to known values', async () => {
    await expectRefused(insertTx({ kind: 'JACKPOT' }), CHECK, 'wager_tx_kind_valid');
    await expectRefused(insertTx({ status: 'DONE' }), CHECK, 'wager_tx_status_valid');
  });

  test('REFUND and ROLLBACK need a reference', async () => {
    await expectRefused(insertTx({ kind: 'REFUND' }), CHECK, 'wager_tx_reversal_has_reference');
    await expectRefused(insertTx({ kind: 'ROLLBACK' }), CHECK, 'wager_tx_reversal_has_reference');
  });

  test('REJECTED/FAILED need a failure_code; PROCESSED needs processed_at', async () => {
    await expectRefused(insertTx({ status: 'REJECTED' }), CHECK, 'wager_tx_rejection_has_code');
    await expectRefused(insertTx({ status: 'FAILED' }), CHECK, 'wager_tx_rejection_has_code');
    await expectRefused(insertTx({ status: 'PROCESSED' }), CHECK, 'wager_tx_processed_has_date');
  });

  test('by design, a transaction for a wallet that does not exist can be stored (as REJECTED WALLET_NOT_FOUND)', async () => {
    await insertTx({ walletId: id(), status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND' });
  });
});

describe('reversal uniqueness: a reference is reversed at most once, by any kind', () => {
  async function processedBet() {
    return insertTx({ kind: 'BET', status: 'PROCESSED', processedAt: new Date().toISOString() });
  }
  const reversal = (kind: string, referenceId: string) =>
    insertTx({
      kind,
      referenceExternalId: 'ref',
      referenceId,
      status: 'PROCESSED',
      processedAt: new Date().toISOString(),
    });

  test('REFUND of a BET twice is refused', async () => {
    const bet = await processedBet();
    await reversal('REFUND', bet);
    await expectRefused(reversal('REFUND', bet), UNIQUE, 'wager_tx_single_reversal_uq');
  });

  test('REFUND and then ROLLBACK of the same BET is refused (would credit twice)', async () => {
    const bet = await processedBet();
    await reversal('REFUND', bet);
    await expectRefused(reversal('ROLLBACK', bet), UNIQUE, 'wager_tx_single_reversal_uq');
  });

  test('ROLLBACK of the REFUND is allowed (different reference)', async () => {
    const bet = await processedBet();
    const refund = await reversal('REFUND', bet);
    await reversal('ROLLBACK', refund);
  });

  test('rejected reversals (no reference_transaction_id) do not take the slot', async () => {
    const bet = await processedBet();
    for (let i = 0; i < 2; i++) {
      await insertTx({ kind: 'REFUND', referenceExternalId: 'ref', status: 'REJECTED', failureCode: 'AMOUNT_MISMATCH' });
    }
    await reversal('REFUND', bet);
  });

  test('several WINs may reference the same BET (WIN is not a reversal)', async () => {
    const bet = await processedBet();
    const win = () =>
      insertTx({ kind: 'WIN', referenceExternalId: 'ref', referenceId: bet, status: 'PROCESSED', processedAt: new Date().toISOString() });
    await win();
    await win();
  });
});

describe('wallet_ledger_entries', () => {
  async function walletAndTx(currency = 'BRL') {
    const walletId = await insertWallet({ currency });
    const transactionId = await insertTx({ walletId });
    return { walletId, transactionId };
  }

  test('at most one entry per (transaction, wallet)', async () => {
    const ids = await walletAndTx();
    await insertLedger(ids);
    await expectRefused(insertLedger(ids), UNIQUE, 'ledger_one_entry_per_tx_wallet_uq');
  });

  test('the database checks the arithmetic: before ± amount = after', async () => {
    const ids = await walletAndTx();
    await expectRefused(insertLedger({ ...ids, before: '100.00', after: '95.00' }), CHECK, 'ledger_balanced');
    await expectRefused(
      insertLedger({ ...ids, direction: 'CREDIT', before: '100.00', after: '90.00' }),
      CHECK,
      'ledger_balanced',
    );
  });

  test('balances never negative and amount greater than zero', async () => {
    const ids = await walletAndTx();
    await expectRefused(insertLedger({ ...ids, before: '5.00', after: '-5.00' }), CHECK, 'ledger_balances_non_negative');
    await expectRefused(insertLedger({ ...ids, amount: '0.00', before: '5.00', after: '5.00' }), CHECK, 'ledger_amount_positive');
  });

  test('entry currency must match the wallet currency (composite FK)', async () => {
    const ids = await walletAndTx('BRL');
    await expectRefused(insertLedger({ ...ids, currency: 'USD' }), FOREIGN_KEY, 'ledger_wallet_currency_fk');
  });

  test('entry needs an existing wallet (money never moves without a wallet)', async () => {
    const transactionId = await insertTx();
    await expectRefused(insertLedger({ walletId: id(), transactionId }), FOREIGN_KEY, 'ledger_wallet_currency_fk');
  });

  test('append-only: UPDATE, DELETE and TRUNCATE are blocked by trigger', async () => {
    const entryId = await insertLedger(await walletAndTx());
    await expectRefused(sql(`UPDATE wallet_ledger_entries SET amount = 1 WHERE id = ?`, [entryId]), RAISED, 'append-only');
    await expectRefused(sql(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [entryId]), RAISED, 'append-only');
    await expectRefused(sql(`TRUNCATE wallet_ledger_entries CASCADE`), RAISED, 'append-only');
    const [row] = await sql(`SELECT amount FROM wallet_ledger_entries WHERE id = ?`, [entryId]);
    expect(row.amount).toBe('10.00'); // intacto
  });
});

describe('inbox_messages', () => {
  test('primary key (consumer_name, message_id) refuses the same message twice for the same consumer', async () => {
    const insert = (consumer: string) =>
      sql(`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, 'msg-1', ?, now())`, [
        consumer,
        'b'.repeat(64),
      ]);
    const consumer = `consumer-${id()}`;
    await insert(consumer);
    await insert(`${consumer}-other`); // outro consumidor pode ver a mesma mensagem
    await expectRefused(insert(consumer), UNIQUE, 'inbox_messages_pkey');
  });
});

describe('outbox_messages', () => {
  test('attempts cannot be negative', async () => {
    await expectRefused(
      sql(
        `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
         VALUES (?, 'agg', 'X', '{}', now(), -1)`,
        [id()],
      ),
      CHECK,
      'outbox_attempts_non_negative',
    );
  });
});
