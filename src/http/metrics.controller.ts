import { Controller, Get, Header } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { registry, useOutboxSource } from '../infrastructure/observability/metrics';

// Sem AuthGuard, como o health: é para o Prometheus da rede interna coletar.
@Controller('metrics')
export class MetricsController {
  constructor(orm: MikroORM) {
    useOutboxSource(orm);
  }

  @Get()
  @Header('content-type', registry.contentType)
  metrics(): Promise<string> {
    return registry.metrics();
  }
}
