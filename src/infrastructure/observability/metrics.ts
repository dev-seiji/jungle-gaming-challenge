import type { MikroORM } from '@mikro-orm/core';
import { Logger } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ProcessResult } from '../../application/process-wager-transaction';

// Métricas no formato Prometheus, expostas em GET /metrics. Ficam só nas BORDAS (controller, consumidor,
// workers, adaptador do banco): domínio e casos de uso não sabem que métricas existem.
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // memória, CPU, event loop do processo

export type Source = 'http' | 'sqs' | 'pending_reference';

export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Transactions decided, by entry point, kind, final status and failure code',
    labelNames: ['source', 'kind', 'status', 'failure_code'],
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_total',
    help: 'Duplicates detected (idempotent replays and inbox hits)',
    labelNames: ['source'],
    registers: [registry],
  }),
  retries: new Counter({
    name: 'wager_retries_total',
    help: 'Retries scheduled by component (sqs_consumer, outbox_publisher, pending_reference)',
    labelNames: ['component'],
    registers: [registry],
  }),
  deadLetters: new Counter({
    name: 'sqs_dead_letter_total',
    help: 'Messages sent to the DLQ by the consumer, by reason',
    labelNames: ['reason'],
    registers: [registry],
  }),
  lockWait: new Histogram({
    name: 'wallet_lock_wait_seconds',
    help: 'Time waiting for the wallet row lock (SELECT ... FOR UPDATE): shows contention on hot wallets',
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  lockTimeouts: new Counter({
    name: 'wallet_lock_timeouts_total',
    help: 'Wallet lock waits that hit lock_timeout (answered as transient 503 / retried from the queue)',
    registers: [registry],
  }),
  processingDuration: new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'End-to-end processing latency of a transaction, by entry point',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Wallets whose stored balance differs from the ledger at reconciliation time',
    registers: [registry],
  }),
};

// Outbox: calculadas NA HORA da coleta (consulta ao banco), então nunca ficam desatualizadas.
let outboxOrm: MikroORM | undefined;
export function useOutboxSource(orm: MikroORM): void {
  outboxOrm = orm;
}

async function outboxStats(): Promise<{ pending: number; lagSeconds: number }> {
  if (!outboxOrm) return { pending: 0, lagSeconds: 0 };
  const [row] = await outboxOrm.em
    .fork()
    .getConnection()
    .execute(
      `SELECT count(*)::int AS pending,
              -- GREATEST: diferença de relógio entre instâncias não pode virar "atraso negativo".
              GREATEST(COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0), 0)::float AS lag
         FROM outbox_messages WHERE published_at IS NULL`,
    );
  return { pending: row.pending, lagSeconds: row.lag };
}

new Gauge({
  name: 'outbox_pending_events',
  help: 'Committed events not yet published',
  registers: [registry],
  async collect() {
    this.set((await outboxStats()).pending);
  },
});

new Gauge({
  name: 'outbox_lag_seconds',
  help: 'Age of the oldest unpublished event (0 when the outbox is empty)',
  registers: [registry],
  async collect() {
    this.set((await outboxStats()).lagSeconds);
  },
});

const decisionLogger = new Logger('Wagering');

/** Uma transação foi decidida: conta na métrica e escreve UM log estruturado (sem valores). */
export function reportDecision(
  source: Source,
  tx: { providerId: string; walletId: string; kind: string },
  result: ProcessResult,
  startedAt: number,
  ids: { correlationId?: string; messageId?: string } = {},
): void {
  const seconds = (performance.now() - startedAt) / 1000;
  metrics.processingDuration.observe({ source }, seconds);
  if (result.idempotentReplay) metrics.duplicates.inc({ source });
  else {
    metrics.transactions.inc({ source, kind: tx.kind, status: result.status, failure_code: result.failureCode ?? 'none' });
  }
  decisionLogger.log({
    msg: 'transaction decided',
    source,
    correlationId: ids.correlationId,
    messageId: ids.messageId,
    transactionId: result.transactionId,
    walletId: tx.walletId,
    providerId: tx.providerId,
    kind: tx.kind,
    status: result.status,
    failureCode: result.failureCode,
    replay: result.idempotentReplay,
    durationMs: Math.round(seconds * 1000),
  });
}
