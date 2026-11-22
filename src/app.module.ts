import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/core';
import { SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from './mikro-orm.config';
import { HealthController } from './health/health.controller';
import { CreateWallet } from './application/create-wallet';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { PostgresQueries } from './infrastructure/persistence/postgres-queries';
import { PostgresWagerStore } from './infrastructure/persistence/postgres-wager-store';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { AuthGuard } from './http/auth.guard';
import { HttpErrorFilter } from './http/http-error.filter';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController, WalletsController, WageringController],
  providers: [
    // Credenciais e região vêm das variáveis AWS_* (cadeia padrão do SDK); o endpoint aponta para o MiniStack.
    { provide: SQSClient, useFactory: () => new SQSClient({ endpoint: process.env.SQS_ENDPOINT }) },
    // Casos de uso e adaptadores são classes simples (sem decorators do Nest): o Nest só os monta aqui.
    { provide: PostgresWagerStore, useFactory: (orm: MikroORM) => new PostgresWagerStore(orm), inject: [MikroORM] },
    { provide: PostgresQueries, useFactory: (orm: MikroORM) => new PostgresQueries(orm), inject: [MikroORM] },
    { provide: ProcessWagerTransaction, useFactory: (s: PostgresWagerStore) => new ProcessWagerTransaction(s), inject: [PostgresWagerStore] },
    { provide: CreateWallet, useFactory: (s: PostgresWagerStore) => new CreateWallet(s), inject: [PostgresWagerStore] },
    {
      provide: OutboxPublisher,
      useFactory: (orm: MikroORM, sqs: SQSClient) => new OutboxPublisher(orm, sqs),
      inject: [MikroORM, SQSClient],
    },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    AuthGuard,
  ],
})
export class AppModule {}
