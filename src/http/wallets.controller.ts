import { Body, Controller, Get, Headers, HttpCode, Logger, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateWallet } from '../application/create-wallet';
import { InvalidInputError } from '../domain/errors';
import { PostgresQueries } from '../infrastructure/persistence/postgres-queries';
import { AuthGuard } from './auth.guard';

const DEFAULT_PAGE_SIZE = 50;

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    private readonly createWallet: CreateWallet,
    private readonly queries: PostgresQueries,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() body: Record<string, unknown> | undefined, @Headers('x-correlation-id') correlationId?: string) {
    return this.createWallet.execute(
      { playerId: body?.playerId as string, initialBalance: body?.initialBalance as never },
      { correlationId: correlationId ?? Bun.randomUUIDv7() },
    );
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return (await this.queries.getWallet(walletId)) ?? notFound('wallet', walletId);
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const size = limit === undefined ? DEFAULT_PAGE_SIZE : Number(limit);
    if (limit !== undefined && !/^\d+$/.test(limit)) throw new InvalidInputError('limit must be a positive integer');
    return (await this.queries.ledgerPage(walletId, cursor, size)) ?? notFound('wallet', walletId);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const report = (await this.queries.reconcile(walletId)) ?? notFound('wallet', walletId);
    // Divergência NÃO é corrigida aqui: corrigir em silêncio esconderia o bug que a causou.
    // Fica logada (e em métrica, Fase 8) e sinalizada na resposta para investigação.
    if (!report.consistent) {
      this.logger.warn(
        `balance/ledger divergence on wallet ${walletId}: stored ${report.storedBalance.amount}, ledger ${report.calculatedBalance.amount}`,
      );
    }
    return report;
  }
}

export function notFound(what: string, id: string): never {
  throw new NotFoundException(`${what} ${id} not found`);
}
