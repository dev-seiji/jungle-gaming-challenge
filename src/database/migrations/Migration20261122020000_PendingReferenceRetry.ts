import { Migration } from '@mikro-orm/migrations';

// Controle de reprocessamento das transações PENDING_REFERENCE (worker da Fase 7).
// ADD COLUMN com DEFAULT constante: desde o Postgres 11 isso só altera metadados (não reescreve a tabela).
export class Migration20261122020000_PendingReferenceRetry extends Migration {
  override name = 'Migration20261122020000_PendingReferenceRetry';

  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN next_reference_attempt_at timestamptz,
        ADD CONSTRAINT wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0)`);
    // Índice parcial: só as pendentes entram nele, então o worker acha as vencidas sem varrer a tabela.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);
  }

  override down(): void {
    this.addSql(`DROP INDEX wager_tx_pending_reference_idx`);
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT wager_tx_reference_attempts_non_negative,
        DROP COLUMN next_reference_attempt_at,
        DROP COLUMN reference_attempts`);
  }
}
