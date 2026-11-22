import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { DuplicateMessageError, IdempotencyConflictError } from '../../application/wager-store';
import { InvalidInputError } from '../../domain/errors';
import { metrics, reportDecision } from '../observability/metrics';
import type { PostgresQueries } from '../persistence/postgres-queries';
import { isTransientDbError } from '../persistence/transient-errors';

export const COMMANDS_QUEUE = 'wager-transactions.fifo';
export const DEAD_LETTER_QUEUE = 'wager-transactions-dlq.fifo';
export const CONSUMER_NAME = 'wager-transactions-consumer';

// Backoff entre entregas de uma falha transitória: 15s, 30s, 60s, 120s (~4 min até a 5ª entrega).
// Na 6ª, a redrive policy da fila (maxReceiveCount=5) move a mensagem sozinha para a DLQ.
const RETRY_BASE_SECONDS = 15;
const MAX_VISIBILITY_SECONDS = 300;

/** Mensagem que nunca vai dar certo, não importa quantas vezes tente (formato inválido). */
class PermanentMessageError extends Error {
  override name = 'PermanentMessageError';
}

type Outcome = 'ack' | 'retry' | 'dead-letter';

export interface WagerConsumerOptions {
  waitTimeSeconds?: number;
  retryBaseSeconds?: number;
}

/**
 * Consome wager-transactions.fifo e chama o MESMO caso de uso do HTTP.
 * Ack (DeleteMessage) só depois do commit. Classificação de erro:
 *  - resultado de negócio (PROCESSED/REJECTED/PENDING_REFERENCE) e duplicata -> ack
 *  - permanente (formato inválido, conflito de idempotência)                 -> DLQ na hora
 *  - transitório ou desconhecido                                             -> retry com backoff; esgotou -> DLQ
 */
export class WagerConsumer {
  private readonly logger = new Logger('WagerConsumer');
  private readonly waitTimeSeconds: number;
  private readonly retryBaseSeconds: number;
  private urls?: { commands: string; deadLetter: string };
  private running = false;
  private loop?: Promise<void>;
  private abort = new AbortController();

  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: PostgresQueries,
    private readonly sqs: SQSClient,
    options: WagerConsumerOptions = {},
  ) {
    this.waitTimeSeconds = options.waitTimeSeconds ?? 5;
    this.retryBaseSeconds = options.retryBaseSeconds ?? RETRY_BASE_SECONDS;
  }

  /** Uma rodada: recebe até 10 mensagens e trata uma por vez. Devolve quantas recebeu. */
  async pollOnce(): Promise<number> {
    const urls = await this.queueUrls();
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: urls.commands,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.waitTimeSeconds, // long polling: não fica martelando a fila vazia
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      // No stop, a espera do long polling é cancelada: o shutdown não fica preso até 5s esperando a fila.
      { abortSignal: this.abort.signal },
    );
    for (const [i, message] of messages.entries()) {
      if (this.stopRequested) {
        // SIGTERM: não começa mensagem nova; devolve as restantes para outra instância pegar já.
        await this.releaseAll(messages.slice(i));
        break;
      }
      await this.handle(message);
    }
    return messages.length;
  }

  async handle(message: Message): Promise<Outcome> {
    let outcome: Outcome;
    let reason = '';
    let errorName = 'unknown';
    try {
      const envelope = parseEnvelope(message.Body);
      if (await this.queries.isMessageProcessed(CONSUMER_NAME, envelope.messageId)) {
        metrics.duplicates.inc({ source: 'sqs' });
        outcome = 'ack'; // redelivery de algo já commitado (ex.: worker morreu antes do ack)
      } else {
        const startedAt = performance.now();
        const result = await this.processWager.execute(envelope.command, {
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          inbox: { consumerName: CONSUMER_NAME, messageId: envelope.messageId },
        });
        reportDecision('sqs', envelope.command, result, startedAt, {
          correlationId: envelope.messageId,
          messageId: envelope.messageId,
        });
        outcome = 'ack'; // execute só retorna depois do COMMIT
      }
    } catch (error) {
      errorName = error instanceof Error ? error.name : 'unknown';
      reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (error instanceof DuplicateMessageError) {
        metrics.duplicates.inc({ source: 'sqs' });
        outcome = 'ack';
      } else if (
        error instanceof PermanentMessageError ||
        error instanceof InvalidInputError ||
        error instanceof IdempotencyConflictError
      ) {
        outcome = 'dead-letter';
      } else {
        // Transitório (banco fora, lock_timeout) OU desconhecido: tenta de novo. Se for um bug que
        // sempre falha, o limite de entregas da fila leva a mensagem para a DLQ — nada se perde.
        if (!isTransientDbError(error)) {
          this.logger.error({ msg: 'unexpected error, will retry', messageId: message.MessageId, error: errorName });
        }
        outcome = 'retry';
      }
    }
    if (outcome === 'retry') metrics.retries.inc({ component: 'sqs_consumer' });
    if (outcome === 'dead-letter') metrics.deadLetters.inc({ reason: errorName });
    await this.apply(message, outcome, reason);
    return outcome;
  }

  private async apply(message: Message, outcome: Outcome, reason: string): Promise<void> {
    const urls = await this.queueUrls();
    if (outcome === 'ack') {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: urls.commands, ReceiptHandle: message.ReceiptHandle }));
      return;
    }
    if (outcome === 'dead-letter') {
      // Primeiro copia para a DLQ, depois apaga: se cair no meio, a mensagem reaparece (nunca some).
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.deadLetter,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: { reason: { DataType: 'String', StringValue: reason.slice(0, 1000) || 'unknown' } },
        }),
      );
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: urls.commands, ReceiptHandle: message.ReceiptHandle }));
      this.logger.warn({ msg: 'message sent to DLQ', messageId: message.MessageId, reason });
      return;
    }
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delay = Math.min(this.retryBaseSeconds * 2 ** (receiveCount - 1), MAX_VISIBILITY_SECONDS);
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: urls.commands,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );
  }

  private async releaseAll(messages: Message[]): Promise<void> {
    const urls = await this.queueUrls();
    for (const m of messages) {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: urls.commands, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }),
      );
    }
  }

  private async queueUrls() {
    if (!this.urls) {
      const url = async (QueueName: string) => (await this.sqs.send(new GetQueueUrlCommand({ QueueName }))).QueueUrl!;
      this.urls = { commands: await url(COMMANDS_QUEUE), deadLetter: await url(DEAD_LETTER_QUEUE) };
    }
    return this.urls;
  }

  private get stopRequested(): boolean {
    return !this.running && this.loop !== undefined;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  /** SIGTERM: para de buscar, termina a mensagem em andamento, devolve as não iniciadas. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort(); // só interrompe a ESPERA por mensagens; o processamento em andamento não usa esse sinal
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break; // receive cancelado pelo stop: saída normal
        this.logger.error(`poll failed: ${(error as Error).message}`);
        await Bun.sleep(1_000); // SQS fora do ar: não entra em loop apertado
      }
    }
  }

  onApplicationBootstrap(): void {
    if (process.env.SQS_CONSUMER_ENABLED !== 'false') this.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }
}

/** Formato da seção 10 do enunciado. Qualquer desvio é permanente: reenviar igual nunca vai funcionar. */
function parseEnvelope(body: string | undefined) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new PermanentMessageError('body is not valid JSON');
  }
  const envelope = parsed as { messageId?: unknown; type?: unknown; data?: Record<string, unknown> };
  if (typeof envelope?.messageId !== 'string' || envelope.messageId === '') {
    throw new PermanentMessageError('messageId is required');
  }
  if (envelope.type !== 'WagerTransactionRequested') throw new PermanentMessageError(`unknown type ${String(envelope.type)}`);
  const d = envelope.data;
  if (typeof d !== 'object' || d === null) throw new PermanentMessageError('data is required');
  for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId', 'kind']) {
    if (typeof d[field] !== 'string' || d[field] === '') throw new PermanentMessageError(`data.${field} is required`);
  }
  if (typeof d.money !== 'object' || d.money === null) throw new PermanentMessageError('data.money is required');
  return {
    messageId: envelope.messageId,
    command: {
      providerId: d.providerId as string,
      externalTransactionId: d.externalTransactionId as string,
      idempotencyKey: d.idempotencyKey as string,
      playerId: d.playerId as string,
      walletId: d.walletId as string,
      roundId: d.roundId as string,
      gameId: d.gameId as string,
      kind: d.kind as string,
      money: d.money as { amount: string; currency: string },
      referenceExternalTransactionId: d.referenceExternalTransactionId as string | undefined,
    },
  };
}
