import { Migration } from '@mikro-orm/migrations';

// Escrita à mão (não gerada pelo ORM): as garantias abaixo — CHECKs com regra de negócio,
// índice único parcial, FK composta e trigger — são o que o enunciado avalia, e o gerador
// automático do MikroORM não sabe expressá-las. Cada uma vale mesmo que o código da aplicação erre.
export class Migration20261122000000_InitialSchema extends Migration {
  override name = 'Migration20261122000000_InitialSchema';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   text          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        -- Alvo da FK composta do ledger: garante que o lançamento tem a mesma moeda da wallet.
        CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      char(64)      NOT NULL,
        -- Sem FK para wallets de propósito: uma transação para wallet inexistente é gravada como
        -- REJECTED (WALLET_NOT_FOUND) para que a idempotency key fique "queimada" e todo reenvio
        -- devolva a mesma rejeição. Dinheiro não se move sem wallet: o ledger mantém a FK.
        wallet_id                         uuid          NOT NULL,
        player_id                         text          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(20,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid          REFERENCES wager_transactions (id),
        status                            text          NOT NULL,
        failure_code                      text,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_amount_positive CHECK (amount > 0),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_tx_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_tx_reversal_has_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_rejection_has_code
          CHECK (status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_processed_has_date CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL)
      )`);

    // Uma referência só pode ser revertida UMA vez, por qualquer tipo (REFUND ou ROLLBACK).
    // Mais rígido que o enunciado ("não duas vezes pelo mesmo tipo"): impede REFUND + ROLLBACK
    // da mesma BET, que creditaria o valor duas vezes. reference_transaction_id só é preenchido
    // quando a reversão é PROCESSED, então reversões rejeitadas não ocupam a vaga.
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK')`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions (id),
        direction       text          NOT NULL,
        amount          numeric(20,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL,
        balance_after   numeric(20,2) NOT NULL,
        created_at      timestamptz   NOT NULL,
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT ledger_one_entry_per_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        -- O próprio banco confere a conta do lançamento.
        CONSTRAINT ledger_balanced CHECK (
          balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount ELSE balance_before - amount END
        )
      )`);

    // Paginação por cursor do extrato: id é UUIDv7 (ordenado pelo tempo), então (wallet_id, id) é estável.
    this.addSql(`CREATE INDEX ledger_wallet_cursor_idx ON wallet_ledger_entries (wallet_id, id)`);

    // Ledger append-only: UPDATE, DELETE e TRUNCATE são bloqueados no banco, não só no código.
    this.addSql(`
      CREATE FUNCTION ledger_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP;
      END
      $$`);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation()`);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_block_mutation()`);

    // Dedup de mensagens da fila: a PK impede gravar a mesma mensagem duas vezes para o mesmo consumidor.
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  char(64)    NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    text        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      )`);

    // O publisher só lê pendentes; o índice parcial fica pequeno porque publicados saem dele.
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql(`DROP TABLE outbox_messages`);
    this.addSql(`DROP TABLE inbox_messages`);
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION ledger_block_mutation()`);
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP TABLE wallets`);
  }
}
