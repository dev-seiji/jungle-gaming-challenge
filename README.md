# Distributed Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, por **HTTP** e por **SQS**. Ele foi feito para continuar correto quando as mensagens chegam **duplicadas**, **fora de ordem** ou **ao mesmo tempo**, com **várias instâncias** rodando.

- Dinheiro exato (`decimal.js` + `NUMERIC(20,2)`), ledger imutável e saldo que nunca fica negativo, com tudo garantido **no banco**.
- Lock pessimista por wallet (`SELECT ... FOR UPDATE`) e idempotência persistente.
- Transactional Outbox, Inbox, retry com backoff, DLQ e reprocessamento de referências que chegam fora de ordem.
- Logs JSON estruturados e métricas Prometheus.

As decisões técnicas, os trade-offs e as limitações estão em **[ARCHITECTURE.md](ARCHITECTURE.md)**.

**Stack:** Bun 1.x · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 18 · AWS SQS via [MiniStack](https://github.com/ministackorg/ministack) · Docker Compose.

---

## Pré-requisitos

| Ferramenta | Versão usada | Para quê |
|---|---|---|
| Docker + Docker Compose | Docker 29 / Compose v5 | sobe Postgres, MiniStack e o app |
| Bun | 1.4.x | só para rodar os testes e o typecheck fora do Docker |

> **Por que MiniStack e não LocalStack?** Desde março de 2026 a imagem atual do LocalStack exige conta e token. O MiniStack é aceito pelo enunciado, é gratuito e não pede cadastro. A imagem está fixada em `ministackorg/ministack:1.5.43`. Detalhes no ARCHITECTURE.md.

---

## Subir tudo

```bash
docker compose up -d --build
```

Isso sobe três serviços:
- **`postgres`**: o banco.
- **`ministack`**: o SQS. Ao ficar pronto, ele cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com redrive policy) e `wallet-events.fifo`.
- **`app`**: roda as migrations e sobe a API na porta **3000**, com os três workers (outbox publisher, consumidor SQS e worker de pendências).

Para conferir que subiu:

```bash
curl localhost:3000/health/live    # {"status":"ok"}
curl localhost:3000/health/ready   # {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Para desligar: `docker compose down` (acrescente `-v` para apagar também os dados do banco).

---

## Exemplos de uso

### 1. Criar uma wallet

```bash
curl -s -X POST localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

```json
{ "id": "<walletId>", "playerId": "0192f28f-...", "balance": { "amount": "1000.00", "currency": "BRL" }, "version": 1 }
```

### 2. Submeter uma aposta (o header `Idempotency-Key` é obrigatório)

```bash
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

```json
{ "transactionId": "<id>", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

Se você reenviar a **mesma** requisição, a resposta é a mesma, com `"idempotentReplay": true`. Se reenviar a mesma key com **outro** payload, a resposta é `409`.

`REFUND` e `ROLLBACK` exigem `"referenceExternalTransactionId"`, que é o id externo da transação revertida.

### 3. Consultas

```bash
curl localhost:3000/wallets/<walletId>
curl "localhost:3000/wallets/<walletId>/ledger?limit=50"            # devolve nextCursor
curl "localhost:3000/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>"
curl localhost:3000/wagering/transactions/<transactionId>
curl localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl -X POST localhost:3000/wallets/<walletId>/reconciliation       # saldo gravado x saldo pelo ledger
curl localhost:3000/metrics                                         # Prometheus
```

### 4. Mandar uma transação pela fila

O app consome `wager-transactions.fifo` usando o mesmo caso de uso do HTTP:

```bash
docker compose exec ministack sh -c 'aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-1 \
  --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-07-29T15:00:00.000Z\",
    \"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-456\",\"idempotencyKey\":\"provider-a:transaction-456\",
    \"playerId\":\"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",\"walletId\":\"<walletId>\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",
    \"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}}"'
```

### Status HTTP (os mesmos em todos os endpoints)

| Status | Significado | Pode reenviar? |
|---|---|---|
| `200` / `201` | processado / wallet criada | — |
| `202` | aceito, aguardando a transação referenciada (`PENDING_REFERENCE`) | não precisa |
| `400` | payload inválido | não, corrija o payload |
| `404` | recurso não existe (consultas) | — |
| `409` | conflito de idempotência ou wallet duplicada | não |
| `422` | rejeitado por regra de negócio (`failureCode` no corpo) | não, decida pelo `failureCode` |
| `503` | falha transitória (banco fora, lock ocupado) | **sim, com a mesma `Idempotency-Key`** |

---

## Testes

Todos os testes de integração usam **Postgres e SQS (MiniStack) reais** do próprio compose. Nada de banco ou fila mockados.

```bash
bun install
cp .env.example .env                       # variáveis para rodar fora do Docker (o Bun lê o .env sozinho)
docker compose up -d postgres ministack
docker compose stop app                    # ⚠️ ver nota abaixo
```

| Comando | O que roda | Tempo |
|---|---|---|
| `bun run test` | unidade + integração: domínio, constraints e migrations, caso de uso com concorrência real, API HTTP, outbox, consumidor SQS, worker de pendências e observabilidade | ~3 s |
| `bun run test:multi` | **3 processos reais do app** em paralelo, `kill -9` no meio da carga, Postgres parado e religado, lock preso → 503 | ~12 s |
| `bun run typecheck` | TypeScript strict (`tsc --noEmit`) | ~2 s |

> **⚠️ O container `app` precisa estar parado durante os testes.** Ele usa o mesmo banco e as mesmas filas, e os workers dele disputariam os eventos e as mensagens dos testes. Os testes que dependem disso conferem e param com uma mensagem clara se o app estiver de pé. Um banco separado para testes está listado como melhoria em ARCHITECTURE.md.

> O teste de migrations (`test/integration/schema.test.ts`) derruba e recria o schema, e com isso apaga os dados do banco local.

Todos os testes que movimentam saldo terminam conferindo o invariante **`saldo da wallet == saldo reconstruído pelo ledger`**.

### Migrations

```bash
bun run migration:up     # aplica as pendentes (o container `app` faz isso sozinho ao subir)
bun run migration:down   # desfaz a última
```

---

## Estrutura

```
src/
  domain/            regras puras: Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos, failureCodes
  application/       casos de uso (ProcessWagerTransaction, CreateWallet, ResolvePendingReference) e a porta WagerStore
  infrastructure/
    persistence/     MikroORM: records + EntitySchema, adaptador (locks, unit of work), consultas, erros transitórios
    messaging/       outbox publisher e consumidor SQS
    scheduling/      worker de PENDING_REFERENCE
    observability/   logger JSON e métricas Prometheus
  http/              controllers, filtro de erros (status HTTP), AuthGuard (ponto de extensão)
  database/migrations/  migrations versionadas e reversíveis (SQL escrito à mão)
test/
  unit/  integration/  multi-instance/
ministack/init/      script que cria as filas
docs/DIARIO.md       diário de desenvolvimento (decisões, bugs encontrados e como foram resolvidos)
```

### Variáveis de ambiente

| Variável | Padrão no compose | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgres://app:app@postgres:5432/wagering` | conexão com o Postgres |
| `SQS_ENDPOINT` | `http://ministack:4566` | endpoint do SQS (MiniStack) |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `us-east-1`, `test`, `test` | credenciais falsas do emulador |
| `PORT` | `3000` | porta HTTP |
| `OUTBOX_PUBLISHER_ENABLED`, `SQS_CONSUMER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga e desliga cada worker (`false` desliga) |
