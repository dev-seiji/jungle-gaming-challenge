import { InvalidTransactionStateError } from './errors';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export type ReceiveInboxProps = Omit<InboxMessageState, 'processedAt'>;

// Registro de "já vi essa mensagem". A garantia de não processar duas vezes é a PK
// (consumer_name, message_id) no banco, gravada na mesma transação do efeito financeiro (Fase 2/6).
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s.messageId, s.consumerName, s.payloadHash, s.receivedAt, s.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidTransactionStateError(`message ${this.messageId} already processed`);
    this._processedAt = at;
  }
}
