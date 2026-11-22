# Handoff: Desafio Backend Jungle Gaming (Distributed Wagering Processor)

Este arquivo é o contrato de trabalho entre o Gabriel (dono do projeto) e o Claude Code.
Leia ele inteiro antes de qualquer ação. O enunciado oficial está em:
https://github.com/junglegaming/backend-challenge (README). Leia o README oficial inteiro também, ele é a fonte da verdade. Se algo aqui contradizer o README oficial, o README oficial vence e você me avisa.

## 1. Contexto e objetivo real

- Sou estudante de Sistemas de Informação (1º ano), tenho base em PHP e pouca experiência com TypeScript, NestJS e sistemas distribuídos.
- Depois da entrega vai ter uma **apresentação onde eu preciso explicar e defender cada decisão**. O objetivo não é só entregar código: é eu **entender tudo** que foi construído.
- Prazo real: domingo 22/11/2026, 16:49 (horário de Campo Grande). **Meta: código pronto domingo 12h, revisão e entrega até 14h.** O tempo é curto: priorize o que está na seção 6.
- O repositório é público e o avaliador precisa conseguir rodar tudo seguindo só o README.

## 2. Regras de trabalho (obrigatórias)

1. **Um agente só.** Não use subagentes nem trabalho em paralelo. Eu preciso acompanhar cada passo.
2. **Trabalhe por fases** (seção 5). No início de cada fase, use o **modo de planejamento**: me mostre o que vai fazer e quais arquivos vai criar ou alterar, e espere meu ok antes de mexer em qualquer arquivo.
3. **Ao terminar cada fase, pare e espere eu dizer "pode seguir".** Não emende fases.
4. **Depois de cada fase**, atualize `docs/DIARIO.md` (seção 3) e me sugira a mensagem de commit. **Eu faço o commit.**
5. **Pesquise antes de implementar.** Antes de usar qualquer biblioteca, API ou integração que você não tenha certeza de como funciona na versão instalada (Bun, NestJS, MikroORM, LocalStack, SDK da AWS), consulte a documentação oficial e confira a versão. Quando der erro, investigue a causa raiz antes de tentar de novo. **Não chute soluções.** Se não encontrar a causa, pare e me explique o que já investigou.
6. Código, nomes de classes, variáveis e mensagens de commit em **inglês** (combina com o enunciado). Comentários didáticos no código, `DIARIO.md` e explicações para mim em **português**.
7. Comente o código explicando o **porquê** nas partes críticas (locks, idempotência, transações, constraints). Não comente o óbvio.
8. Quando eu fizer uma pergunta, **só responda**. Não altere arquivos sem eu pedir.

### Diretrizes de código (karpathy-guidelines)

Se a skill karpathy-guidelines estiver disponível, siga ela. Se não estiver, siga estas regras:

- **Simplicidade primeiro:** escreva o mínimo de código que resolve o requisito. Sem abstrações, camadas ou configurações "para o futuro". Entre duas soluções, escolha a que eu consigo explicar.
- **Mudanças cirúrgicas:** toque só no que a fase pede. Nada de refatorar, renomear ou "melhorar" código vizinho.
- **Suposições explícitas:** se o enunciado não define algo, não decida em silêncio. Registre a suposição no `DIARIO.md` (e depois no `ARCHITECTURE.md`) e, se for importante, me pergunte.
- **Critério de sucesso verificável:** cada fase termina com testes que provam que ela funciona. Rode os testes e me mostre o resultado; não diga que funciona sem ter rodado.

## 3. O diário de aprendizado (`docs/DIARIO.md`)

Este é o item mais importante para mim. Ao final de cada fase, adicione uma seção com:

- **O que foi feito** (3 a 6 linhas, linguagem simples).
- **Fluxo** da parte construída usando setas, por exemplo:
  `Requisição HTTP → valida payload → calcula hash → abre transação SQL → trava a wallet (FOR UPDATE) → aplica regra → grava ledger + outbox → commit → responde`
- **Conceitos novos** que apareceram (ex.: idempotência, lock pessimista, outbox), cada um com uma explicação curta e uma analogia do dia a dia.
- **Decisões e alternativas descartadas** (por que A e não B).
- **Perguntas prováveis da banca e como responder** (2 a 4 por fase). Ex.: "O que acontece se o processo morrer depois do commit e antes do ack?"
- **Arquivos principais da fase** e o papel de cada um em uma linha.

## 4. Stack e decisões já aprovadas

Obrigatório pelo enunciado: Bun 1.x, TypeScript strict, NestJS, PostgreSQL, AWS SQS via LocalStack, Docker Compose, migrations versionadas e reversíveis.

Decisões aprovadas por mim:

- **ORM:** MikroORM (preferencial do enunciado). Mapeamento fora das classes de domínio (ex.: `EntitySchema`), para o domínio não depender de decorators do ORM nem do NestJS. **Plano B:** se MikroORM não funcionar bem com Bun na Fase 0, me avise e trocamos para TypeORM (também aceito). Não insista por horas.
- **Dinheiro:** `decimal.js` dentro da classe `Money`. No banco, `NUMERIC(20,2)` + coluna `currency CHAR(3)`. **Nunca `number` para dinheiro** (falha eliminatória).
- **Moeda:** operar com `BRL`, mas modelo multi-moeda e conflito de moeda testado.
- **Concorrência:** lock pessimista por linha da wallet (`SELECT ... FOR UPDATE`) dentro da transação SQL. `version` começa em 1 e incrementa só quando o saldo muda.
- **Idempotência:** garantida por unique constraint no banco, nunca em memória. `payloadHash` = SHA-256 de JSON canônico (chaves ordenadas) dos campos de negócio, sem header nem metadados de transporte.
- **Outbox publisher e worker de PENDING_REFERENCE:** `SELECT ... FOR UPDATE SKIP LOCKED` para funcionar com várias instâncias.
- **Autenticação:** não implementar (vale 0 pontos). `AuthGuard` no-op como ponto de extensão e documentação no `ARCHITECTURE.md` de como seria com Keycloak.
- **Teste de carga:** não fazer.
- **Testes:** `bun test`, com integração contra PostgreSQL e LocalStack reais **do próprio Docker Compose** (sem Testcontainers). Nada de mock de banco ou fila nos testes de integração (falha eliminatória).
- **Status HTTP:** 400 payload inválido; 409 conflito de idempotência ou wallet duplicada; 422 rejeição por regra de negócio; 202 aceito aguardando referência; 503 falha transitória de infraestrutura; 200/201 sucesso. Consistente em todos os endpoints.
- **Métricas:** endpoint `/metrics` no formato Prometheus, sem dashboard.

## 5. Fases

Cada fase termina com: testes da fase passando (rodados de verdade), `DIARIO.md` atualizado, sugestão de commit, e você parado esperando meu "pode seguir".

**Fase 0. Esqueleto e infraestrutura**
- Projeto NestJS rodando com Bun, TypeScript strict.
- `docker-compose.yml` com PostgreSQL, LocalStack (filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` com redrive policy) e o app.
- MikroORM configurado com migrations.
- `GET /health/live` e `GET /health/ready` (Postgres e SQS), sem autenticação.
- Critério: `docker compose up` sobe tudo e os dois health checks respondem.

**Fase 1. Domínio puro (sem banco)**
- `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos de integração (classe abstrata + subclasses).
- Construtor privado + factories `create`/`from`/`rehydrate`, transições explícitas, estados terminais.
- Taxonomia de `failureCode` (ex.: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `CURRENCY_MISMATCH`, `AMOUNT_MISMATCH`, `ALREADY_REVERSED`, `INVALID_REFERENCE_KIND`...).
- Testes unitários do item "Unidade" do enunciado.

**Fase 2. Schema e migrations**
- Tabelas: wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages.
- Constraints no banco (exigência explícita): unique (player_id, currency); `CHECK (balance >= 0)`; unique (provider_id, external_transaction_id); unique idempotency_key; no máximo um lançamento por (transaction_id, wallet_id); ledger imutável (trigger que bloqueia UPDATE/DELETE); unique de reversão por (referência, tipo); PK do inbox (consumer_name, message_id).
- Testes de integração das constraints e das migrations (up e down).

**Fase 3. Caso de uso principal (o coração)**
- `ProcessWagerTransaction` com as regras de BET, WIN, LOSS, REFUND, ROLLBACK, idempotência (replay retorna o resultado original, payload diferente é conflito) e PENDING_REFERENCE.
- Tudo na mesma transação SQL: transação + saldo + ledger + outbox (+ inbox quando vier da fila).
- Testes: cenário obrigatório (saldo 100, duas apostas de 80 em paralelo), mesma aposta 50x em paralelo, wallets diferentes em paralelo.

**Fase 4. API HTTP**
- Endpoints da seção 9 do enunciado, incluindo `POST /wallets` com transação `OPENING`, ledger paginado por cursor opaco e reconciliação.
- Mapeamento de status HTTP da seção 4.

**Fase 5. Outbox publisher**
- Worker que publica eventos pendentes com backoff, seguro com vários publishers.
- Testes: commit feito, processo morre antes de publicar, outra instância publica; dois publishers na mesma outbox.

**Fase 6. Consumidor SQS**
- Reusa o mesmo caso de uso do HTTP; dedup pelo inbox; ack só depois do commit; erro de negócio = ack, transitório = retry, permanente = DLQ; tratamento de SIGTERM.
- Testes: redelivery, worker morto depois do commit e antes do ack, retry e DLQ.

**Fase 7. Worker de PENDING_REFERENCE**
- Reprocessa com backoff exponencial; limite de tentativas definido e justificado; ao esgotar, REJECTED com `REFERENCE_NOT_FOUND` e evento.
- Teste: REFUND/ROLLBACK chegando antes da referência.

**Fase 8. Observabilidade**
- Logs JSON estruturados com correlationId, messageId, transactionId, walletId, providerId, sem payload financeiro completo.
- Métricas em `/metrics`: transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência.

**Fase 9. Múltiplas instâncias e recuperação**
- Teste com 3 ou mais processos simultâneos e teste de reinício do serviço.
- Todo teste termina verificando: `saldo da wallet == saldo reconstruído pelo ledger`.

**Fase 10. Documentação**
- `README.md`: pré-requisitos, como subir, como rodar cada tipo de teste, exemplos de chamadas.
- `ARCHITECTURE.md`: escolha do ORM, mapeamento do Money, estratégia transacional e de concorrência, idempotência e hash, transições de estado, failureCodes, mapeamento HTTP, limite de retries, autenticação não implementada, trade-offs e limitações conhecidas.

## 6. Prioridade se o tempo apertar

**Não pode faltar** (falhas eliminatórias e itens de maior peso):
1. Money sem `number`, ledger imutável, saldo nunca negativo.
2. Concorrência correta com várias instâncias (Fase 3).
3. Idempotência persistente.
4. Outbox (nada de publicar antes do commit).
5. Testes com Postgres e LocalStack reais.
6. Documentação honesta do que ficou de fora.

**Pode ficar mais simples, se documentado:** observabilidade (Fase 8) e o teste com 3 instâncias (Fase 9).

Se uma fase estiver demorando demais, me avise com uma proposta de corte em vez de seguir sozinho.

## 7. Primeira ação

Leia este arquivo e o README oficial. Depois me responda, **sem criar nenhum arquivo ainda**:
1. Um resumo de 5 linhas do que entendeu do desafio.
2. Riscos técnicos que você vê na stack (Bun + NestJS + MikroORM + LocalStack) e como verificar cada um, consultando a documentação.
3. O plano detalhado da Fase 0.

Depois espere meu "pode seguir".
