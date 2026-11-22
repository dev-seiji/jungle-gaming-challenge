import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

const QUEUES = ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wallet-events.fifo'];
// Health check precisa responder rápido: dependência travada conta como "fora", não como espera infinita.
const TIMEOUT_MS = 2000;

async function check(probe: () => Promise<unknown>): Promise<'up' | 'down'> {
  const timeout = new Promise((_, reject) => setTimeout(reject, TIMEOUT_MS));
  try {
    await Promise.race([probe(), timeout]);
    return 'up';
  } catch {
    return 'down';
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
  ) {}

  // Liveness: só diz "o processo está vivo". Não checa dependências, senão o orquestrador
  // reiniciaria o app por causa de um banco fora do ar (o que reiniciar não resolve).
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  // Readiness: "posso receber tráfego?". Exige Postgres e as duas filas alcançáveis.
  @Get('ready')
  async ready() {
    const checks = {
      postgres: await check(() => this.orm.em.getConnection().execute('select 1')),
      sqs: await check(() =>
        Promise.all(QUEUES.map((QueueName) => this.sqs.send(new GetQueueUrlCommand({ QueueName })))),
      ),
    };
    if (checks.postgres === 'down' || checks.sqs === 'down') {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    return { status: 'ok', checks };
  }
}
