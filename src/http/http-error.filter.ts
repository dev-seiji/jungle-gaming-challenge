import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { IdempotencyConflictError, WalletAlreadyExistsError } from '../application/wager-store';
import { InvalidInputError } from '../domain/errors';
import { isTransientDbError } from '../infrastructure/persistence/transient-errors';

export interface HttpError {
  status: number;
  body: { error: string; message: string; retryable: boolean; walletId?: string };
}

/**
 * ÚNICO lugar que traduz erro -> status HTTP, então o mapeamento é igual em todos os endpoints.
 * `retryable` diz ao provedor, sem interpretar mensagem, se pode reenviar o mesmo payload.
 * (Rejeição de negócio não passa por aqui: é um resultado normal, devolvido com 422 pelo controller.)
 */
export function toHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof InvalidInputError) return { status: 400, body: { error: 'INVALID_INPUT', message, retryable: false } };
  if (error instanceof IdempotencyConflictError) {
    return { status: 409, body: { error: 'IDEMPOTENCY_CONFLICT', message, retryable: false } };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return { status: 409, body: { error: 'WALLET_ALREADY_EXISTS', message, retryable: false, walletId: error.walletId } };
  }
  if (isTransientDbError(error)) {
    return { status: 503, body: { error: 'TRANSIENT_FAILURE', message: 'temporarily unavailable, retry later', retryable: true } };
  }
  if (error instanceof HttpException) {
    // Erros do próprio Nest: JSON malformado (400), rota inexistente (404) e os NotFound dos controllers.
    const status = error.getStatus();
    const code = status === 404 ? 'NOT_FOUND' : status === 400 ? 'INVALID_INPUT' : 'HTTP_ERROR';
    return { status, body: { error: code, message, retryable: false } };
  }
  return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'unexpected error', retryable: false } };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(error: unknown, host: ArgumentsHost) {
    const { status, body } = toHttpError(error);
    if (status >= 500) this.logger.error(error instanceof Error ? error.stack : String(error));
    host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>().status(status).json(body);
  }
}
