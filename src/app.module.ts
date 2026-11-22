import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from './mikro-orm.config';
import { HealthController } from './health/health.controller';

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController],
  providers: [
    // Credenciais e região vêm das variáveis AWS_* (cadeia padrão do SDK); o endpoint aponta para o MiniStack.
    { provide: SQSClient, useFactory: () => new SQSClient({ endpoint: process.env.SQS_ENDPOINT }) },
  ],
})
export class AppModule {}
