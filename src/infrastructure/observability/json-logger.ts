import type { LoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger do Nest que escreve UMA linha JSON por evento (fácil de indexar em Loki/ELK/CloudWatch).
 * `logger.log({ msg, transactionId, ... })` vira campos no JSON; string vira { msg }.
 * Regra do projeto: só ids, status e códigos — nunca valor, saldo ou corpo de requisição.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]) {
    // O Nest chama (message, context) e, em erro, (message, stack, context).
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined;
    const stack = level === 'error' && rest.length >= 2 && typeof rest[0] === 'string' ? rest[0] : undefined;
    const fields = typeof message === 'object' && message !== null ? message : { msg: String(message) };
    const line = { level, time: new Date().toISOString(), context, ...fields, ...(stack ? { stack } : {}) };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}
