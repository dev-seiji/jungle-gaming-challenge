import { InvalidTransactionStateError } from './errors';
import type { IntegrationEvent } from './events';

// Backoff exponencial: 1s, 2s, 4s, 8s... até no máximo 5 min entre tentativas.
// Sem limite de tentativas: evento confirmado no banco não pode ser descartado; o teto do intervalo
// evita martelar o SQS enquanto ele estiver fora, e a métrica de outbox lag (Fase 8) mostra o atraso.
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: quem consome deduplica por ele se o publisher enviar duas vezes. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON();
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this._attempts - 1), MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
