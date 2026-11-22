// Integração real: precisa de `docker compose up -d postgres ministack` e de um .env (veja .env.example).
import 'reflect-metadata';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  // Workers em segundo plano desligados: senão disputariam fila/outbox com os testes do consumidor e do publisher.
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0); // porta livre qualquer, para não brigar com um app já rodando
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

test('GET /health/live responds 200', async () => {
  const res = await fetch(`${baseUrl}/health/live`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('GET /health/ready responds 200 when Postgres and both queues are reachable', async () => {
  const res = await fetch(`${baseUrl}/health/ready`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
});
