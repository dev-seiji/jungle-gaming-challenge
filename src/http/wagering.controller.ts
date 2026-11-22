import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { type ProcessWagerCommand, ProcessWagerTransaction } from '../application/process-wager-transaction';
import { InvalidInputError } from '../domain/errors';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { PostgresQueries } from '../infrastructure/persistence/postgres-queries';
import { AuthGuard } from './auth.guard';
import { notFound } from './wallets.controller';

// O resultado do caso de uso decide o status. Replay devolve o MESMO status da primeira vez
// ("requisição idêntica -> mesma resposta"); quem diferencia é o campo idempotentReplay.
const STATUS_BY_RESULT: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Rejected]: 422,
};

const REQUIRED_FIELDS = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind'] as const;

/** Validação do formato na borda (400). Regras de negócio ficam no caso de uso / domínio. */
function toCommand(body: unknown, idempotencyKey: string | undefined): ProcessWagerCommand {
  if (!idempotencyKey?.trim()) throw new InvalidInputError('Idempotency-Key header is required');
  if (typeof body !== 'object' || body === null) throw new InvalidInputError('body must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (typeof b[field] !== 'string' || (b[field] as string).trim() === '') {
      throw new InvalidInputError(`${field} is required and must be a non-empty string`);
    }
  }
  if (typeof b.money !== 'object' || b.money === null) throw new InvalidInputError('money is required');
  const ref = b.referenceExternalTransactionId;
  if (ref !== undefined && typeof ref !== 'string') throw new InvalidInputError('referenceExternalTransactionId must be a string');
  return {
    providerId: b.providerId as string,
    externalTransactionId: b.externalTransactionId as string,
    idempotencyKey,
    playerId: b.playerId as string,
    walletId: b.walletId as string,
    roundId: b.roundId as string,
    gameId: b.gameId as string,
    kind: b.kind as string,
    money: b.money as ProcessWagerCommand['money'],
    referenceExternalTransactionId: ref as string | undefined,
  };
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: PostgresQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ) {
    const result = await this.processWager.execute(toCommand(body, idempotencyKey), {
      correlationId: correlationId ?? Bun.randomUUIDv7(),
    });
    res.status(STATUS_BY_RESULT[result.status] ?? 500);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    return (await this.queries.getTransaction(transactionId)) ?? notFound('transaction', transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return (
      (await this.queries.getTransactionByExternalId(providerId, externalId)) ??
      notFound('transaction', `${providerId}/${externalId}`)
    );
  }
}
