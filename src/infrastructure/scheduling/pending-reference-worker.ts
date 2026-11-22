import { Logger } from '@nestjs/common';
import type { ResolvePendingReference } from '../../application/resolve-pending-reference';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { metrics, reportDecision } from '../observability/metrics';

const IDLE_INTERVAL_MS = 1_000;

/** Loop agendado que chama ResolvePendingReference. Roda dentro do app; várias instâncias são seguras (SKIP LOCKED). */
export class PendingReferenceWorker {
  private readonly logger = new Logger('PendingReferenceWorker');
  private running = false;
  private loop?: Promise<void>;

  constructor(private readonly resolve: ResolvePendingReference) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de pegar trabalho novo e espera a transação em andamento terminar. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let found = false;
      try {
        const startedAt = performance.now();
        const outcome = await this.resolve.runOnce();
        found = outcome !== undefined;
        if (outcome && outcome.result.status === WagerTransactionStatus.PendingReference) {
          metrics.retries.inc({ component: 'pending_reference' }); // referência ainda ausente: nova tentativa agendada
        } else if (outcome) {
          reportDecision('pending_reference', outcome.transaction, outcome.result, startedAt, {
            correlationId: outcome.transaction.id,
          });
        }
      } catch (error) {
        this.logger.error(`pending reference round failed: ${(error as Error).message}`);
      }
      // Achou uma: provavelmente há mais vencidas, segue direto. Senão, dorme.
      if (!found) await Bun.sleep(IDLE_INTERVAL_MS);
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED !== 'false') this.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}
