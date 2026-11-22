// Precisa ser o primeiro import: os decorators das classes usam Reflect.metadata ao serem carregados.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const app = await NestFactory.create(AppModule);
// Repassa SIGTERM/SIGINT para os hooks do Nest (fecha conexões com o banco de forma limpa).
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 3000));
