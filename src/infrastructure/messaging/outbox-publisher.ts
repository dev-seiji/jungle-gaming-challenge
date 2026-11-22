import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { LockMode, type MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { OutboxMessage } from '../../domain/outbox-message';
import { metrics } from '../observability/metrics';
import { OutboxRecord } from '../persistence/records';

export const EVENTS_QUEUE = 'wallet-events.fifo';
const SEND_TIMEOUT_MS = 5_000;

export interface OutboxPublisherOptions {
  batchSize?: number;
  intervalMs?: number;
}

/**
 * Publica no SQS os eventos que já estão COMMITADOS na outbox (nunca antes do commit).
 * Seguro com várias instâncias: SELECT ... FOR UPDATE SKIP LOCKED faz cada instância pegar linhas
 * diferentes, sem esperar uma pela outra. Entrega at-least-once: se o processo morrer depois do SendMessage
 * e antes do COMMIT, a linha volta a ficar pendente e é publicada de novo — o consumidor deduplica pelo eventId.
 */
export class OutboxPublisher {
  private readonly logger = new Logger('OutboxPublisher');
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private queueUrl?: string;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    options: OutboxPublisherOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 10;
    this.intervalMs = options.intervalMs ?? 500;
  }

  /** Uma rodada: pega até `batchSize` eventos vencidos, publica e marca. Devolve quantos publicou. */
  async publishBatch(now = new Date()): Promise<number> {
    const em = this.orm.em.fork() as EntityManager;
    return em.transactional(async (txEm) => {
      const records = await txEm.find(
        OutboxRecord,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        { orderBy: { occurredAt: 'asc', id: 'asc' }, limit: this.batchSize, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
      );
      let published = 0;
      for (const record of records) {
        const message = toDomain(record);
        try {
          await this.send(message);
          message.markPublished(new Date());
          published++;
        } catch (error) {
          // SQS fora do ar: o evento NÃO se perde — fica pendente e volta com backoff exponencial.
          message.scheduleRetry(new Date());
          metrics.retries.inc({ component: 'outbox_publisher' });
          this.logger.warn({
            msg: 'event publish failed, will retry',
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            error: (error as Error).message,
          });
        }
        // Unit of Work: as mudanças nos records viram UPDATE no flush do commit.
        record.attempts = message.attempts;
        record.nextAttemptAt = message.nextAttemptAt ?? null;
        record.publishedAt = message.publishedAt ?? null;
      }
      return published;
    });
  }

  private async send(message: OutboxMessage): Promise<void> {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: EVENTS_QUEUE }))).QueueUrl;
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // Ordem por agregado: eventos da mesma wallet/transação saem na ordem em que aconteceram.
        MessageGroupId: message.aggregateId,
        // Otimização: o SQS descarta duplicata com o mesmo id por 5 min. A garantia real é o eventId no consumidor.
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
      { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Para de pegar trabalho novo e espera a rodada atual terminar (shutdown limpo). */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = await this.publishBatch();
      } catch (error) {
        this.logger.error(`outbox round failed: ${(error as Error).message}`);
      }
      // Lote cheio = provavelmente tem mais esperando: segue direto. Senão, dorme um pouco.
      if (published < this.batchSize) await Bun.sleep(this.intervalMs);
    }
  }

  // Ganchos de ciclo de vida que o Nest chama sozinho (basta o método existir).
  onApplicationBootstrap(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED !== 'false') this.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}

function toDomain(r: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
  });
}
