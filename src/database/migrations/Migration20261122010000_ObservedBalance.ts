import { Migration } from '@mikro-orm/migrations';

// Regra 7 do enunciado: o replay devolve o resultado original, INCLUINDO o saldo observado naquele momento.
// LOSS e rejeições não geram lançamento no ledger, então o saldo daquele momento precisa ficar guardado
// na própria transação. Migration nova (e não edição da inicial): migration aplicada não se edita.
// Colunas anuláveis sem default: no Postgres isso só altera metadados, sem reescrever nem travar a tabela.
export class Migration20261122010000_ObservedBalance extends Migration {
  override name = 'Migration20261122010000_ObservedBalance';

  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN observed_balance_amount numeric(20,2),
        -- Moeda própria: em CURRENCY_MISMATCH o saldo está na moeda da wallet, não na da transação.
        ADD COLUMN observed_balance_currency char(3),
        ADD CONSTRAINT wager_tx_observed_balance_pair
          CHECK ((observed_balance_amount IS NULL) = (observed_balance_currency IS NULL)),
        ADD CONSTRAINT wager_tx_observed_balance_non_negative CHECK (observed_balance_amount >= 0)`);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT wager_tx_observed_balance_non_negative,
        DROP CONSTRAINT wager_tx_observed_balance_pair,
        DROP COLUMN observed_balance_currency,
        DROP COLUMN observed_balance_amount`);
  }
}
