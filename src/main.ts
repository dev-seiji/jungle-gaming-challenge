// Precisa ser o primeiro import: os decorators das classes usam Reflect.metadata ao serem carregados.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './infrastructure/observability/json-logger';

// Logs em JSON, uma linha por evento (todos os `new Logger(...)` do projeto passam por aqui).
const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
// Repassa SIGTERM/SIGINT para os hooks do Nest (fecha conexões com o banco de forma limpa).
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000));
