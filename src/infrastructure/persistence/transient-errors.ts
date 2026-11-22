import { DeadlockException } from '@mikro-orm/core';

// Falha TRANSITÓRIA = tentar de novo, mais tarde, com o mesmo payload, pode dar certo.
// HTTP devolve 503 (o provedor reenvia com a mesma Idempotency-Key, o que é seguro);
// a fila (Fase 6) faz retry com backoff em vez de mandar para a DLQ.
const TRANSIENT_CODES = new Set([
  '55P03', // lock_not_available: estourou o lock_timeout esperando uma wallet "quente"
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57P01', // admin_shutdown: Postgres reiniciando
  '57P03', // cannot_connect_now: Postgres subindo
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

export function isTransientDbError(error: unknown): boolean {
  if (error instanceof DeadlockException) return true;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) return true; // 08xxx = conexão
  // O driver pg às vezes lança erro de conexão sem código; aí só a mensagem identifica.
  const message = error instanceof Error ? error.message : '';
  return /Connection terminated|ECONNREFUSED|timeout exceeded when trying to connect/i.test(message);
}
