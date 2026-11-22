// Integração real: sobe o app inteiro (Postgres do compose) e confere /metrics e o formato dos logs.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import { AppModule } from '../../src/app.module';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { reportDecision } from '../../src/infrastructure/observability/metrics';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
  await app.get(MikroORM).migrator.up();
});

afterAll(async () => {
  await app.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function scrape(): Promise<string> {
  const res = await fetch(`${base}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  return res.text();
}

/** Valor de uma série exata do texto Prometheus (0 se ainda não existe). */
function value(text: string, series: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

describe('GET /metrics', () => {
  test('counts transactions by status, duplicates, lock waits; exposes outbox lag', async () => {
    const before = await scrape();
    const processed = 'wager_transactions_total{source="http",kind="BET",status="PROCESSED",failure_code="none"}';
    const rejected = 'wager_transactions_total{source="http",kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"}';
    const duplicates = 'wager_duplicates_total{source="http"}';

    const wallet = (await (await post('/wallets', { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '10.00', currency: 'BRL' } })).json()) as any;
    const bet = (ext: string, amount: string) =>
      post(
        '/wagering/transactions',
        {
          providerId: 'provider-a',
          externalTransactionId: ext,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount, currency: 'BRL' },
        },
        { 'idempotency-key': `provider-a:${ext}` },
      );
    const ext = `tx-${Bun.randomUUIDv7()}`;
    await bet(ext, '5.00'); // PROCESSED
    await bet(ext, '5.00'); // replay = duplicata
    await bet(`tx-${Bun.randomUUIDv7()}`, '50.00'); // REJECTED INSUFFICIENT_FUNDS

    const after = await scrape();
    expect(value(after, processed) - value(before, processed)).toBe(1);
    expect(value(after, rejected) - value(before, rejected)).toBe(1);
    expect(value(after, duplicates) - value(before, duplicates)).toBe(1);
    expect(value(after, 'wallet_lock_wait_seconds_count')).toBeGreaterThan(value(before, 'wallet_lock_wait_seconds_count'));
    expect(value(after, 'wager_processing_duration_seconds_count{source="http"}')).toBeGreaterThan(0);
    // Outbox: há eventos não publicados (publisher desligado neste teste), então o lag é > 0.
    expect(value(after, 'outbox_pending_events')).toBeGreaterThan(0);
    expect(value(after, 'outbox_lag_seconds')).toBeGreaterThan(0);
    // As demais métricas exigidas existem (com HELP/TYPE), mesmo antes do primeiro incremento.
    for (const name of ['wager_retries_total', 'sqs_dead_letter_total', 'wallet_lock_timeouts_total', 'reconciliation_divergences_total']) {
      expect(after).toContain(`# TYPE ${name} counter`);
    }
  });
});

describe('structured JSON logs', () => {
  test('one JSON line per decision, with ids and without amounts or balances', () => {
    const lines: string[] = [];
    const write = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    Logger.overrideLogger(new JsonLogger());
    try {
      reportDecision(
        'sqs',
        { providerId: 'provider-a', walletId: 'w-1', kind: 'BET' },
        {
          transactionId: 't-1',
          status: WagerTransactionStatus.Processed,
          balance: { amount: '975.00', currency: 'BRL' }, // NÃO pode ir para o log
          idempotentReplay: false,
        },
        performance.now(),
        { correlationId: 'c-1', messageId: 'm-1' },
      );
    } finally {
      write.mockRestore();
      Logger.overrideLogger(false);
    }

    const line = lines.find((l) => l.includes('transaction decided'))!;
    const log = JSON.parse(line);
    expect(log).toMatchObject({
      level: 'info',
      context: 'Wagering',
      msg: 'transaction decided',
      correlationId: 'c-1',
      messageId: 'm-1',
      transactionId: 't-1',
      walletId: 'w-1',
      providerId: 'provider-a',
      status: 'PROCESSED',
    });
    expect(line).not.toContain('975.00');
    expect(line).not.toContain('balance');
    expect(line).not.toContain('amount');
  });
});
