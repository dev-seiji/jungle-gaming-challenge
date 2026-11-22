# Diário de aprendizado

## Fase 0 — Esqueleto e infraestrutura

### O que foi feito

- Projeto NestJS rodando com Bun e TypeScript em modo `strict`.
- `docker-compose.yml` sobe três serviços: PostgreSQL 18, MiniStack (emulador do SQS) e o app.
- As filas `wager-transactions.fifo` e `wager-transactions-dlq.fifo` são criadas quando o MiniStack fica pronto. A principal manda para a DLQ depois de 5 entregas sem ack.
- MikroORM 7 configurado com migrations. O app roda `migration:up` antes de subir.
- `GET /health/live` (processo vivo) e `GET /health/ready` (Postgres e filas alcançáveis), ambos sem autenticação.

### Fluxo

Subida:
`docker compose up → Postgres fica healthy (pg_isready) → MiniStack fica healthy (script cria DLQ → cria fila principal com redrive) → app: roda migrations → sobe o Nest na porta 3000`

Readiness:
`GET /health/ready → SELECT 1 no Postgres (máx. 2s) → GetQueueUrl das 2 filas (máx. 2s) → tudo "up"? 200 : 503 dizendo quem caiu`

### Conceitos novos

- **Liveness x Readiness.** *Liveness* pergunta "o processo está vivo?". *Readiness* pergunta "ele consegue trabalhar agora?". Se o banco cai, o app continua vivo, só não está pronto. Reiniciar o app não conserta o banco, por isso o `live` não checa dependências.
  *Analogia:* o caixa da padaria está no trabalho (vivo), mas a maquininha de cartão caiu, então ele não está pronto para atender.
- **DLQ (Dead Letter Queue) e redrive policy.** Quando uma mensagem falha muitas vezes (mais que `maxReceiveCount`), a fila a move sozinha para outra fila, a DLQ. Assim ela não fica travando a fila nem some.
  *Analogia:* uma carta com endereço errado vai para a seção de "cartas não entregues", em vez de voltar ao carteiro para sempre.
- **Fila FIFO.** Entrega em ordem dentro de um mesmo grupo (`MessageGroupId`) e deduplica envios repetidos dentro de 5 minutos. O enunciado deixa claro que isso é **otimização**: quem garante a correção é o banco.
- **Healthcheck no Docker Compose + `depends_on: service_healthy`.** O app só sobe quando o banco e as filas estão prontos de verdade, e não apenas com o container "ligado".
- **Decorators e metadados.** O NestJS descobre o que injetar no construtor (por exemplo `MikroORM` e `SQSClient`) lendo os tipos em tempo de execução. Isso exige `experimentalDecorators` + `emitDecoratorMetadata` no `tsconfig.json` e `import 'reflect-metadata'` antes de tudo.

### Decisões e alternativas descartadas

- **MiniStack em vez de LocalStack.** Desde março de 2026, a imagem atual do LocalStack exige conta e token. Isso quebraria o "o avaliador roda só com o README". Testamos o LocalStack 4.14 (a última versão sem token) e ele funciona, mas escolhemos o MiniStack (aceito pelo enunciado). A versão fica fixada em `1.5.43` para não mudar sozinha. Antes de adotar, validamos na prática FIFO + redrive + DLQ: a mensagem foi parar na DLQ depois de `maxReceiveCount` entregas.
- **Bug encontrado no init do MiniStack.** A imagem traz o aws-cli **v1**, que ignora a variável `AWS_ENDPOINT_URL` e mandava as chamadas para a AWS real (erro `InvalidClientTokenId`). Causa confirmada imprimindo o ambiente do script. Solução: `--endpoint-url` explícito em todo comando.
- **Script próprio de migration (`scripts/migrate.ts`) em vez da CLI do MikroORM.** A CLI espera Node + ts-node. O Bun já executa TypeScript, então 15 linhas chamando `orm.migrator.up()/down()` resolvem sem dependência extra.
- **Migrations rodam na subida do app.** É simples. **Limitação a revisar na Fase 9:** com várias instâncias subindo juntas, todas tentam migrar. O MikroORM roda tudo em transação (`allOrNothing`), mas isso precisa ser verificado.
- **Timeout de 2s no readiness.** Sem ele, um banco "pendurado" deixaria o health check esperando para sempre. Uma dependência travada conta como "fora".
- **Sem migration vazia nesta fase.** O plano dizia "provar up/down com uma migration vazia". Cortamos isso porque um arquivo sem conteúdo no repositório não se defende na banca. Nesta fase provamos que o migrator conecta e roda (`0 migration(s) executed`). O teste de up/down de verdade fica na Fase 2, com as tabelas reais.
- **Teste sobe o Nest dentro do `bun test`** (porta aleatória) contra Postgres e MiniStack reais do compose. Isso também prova que a injeção de dependências do Nest funciona no test runner do Bun.

### Perguntas prováveis da banca

- **"Por que o `/health/live` não checa o banco?"** Se checasse, uma queda do banco faria o orquestrador (Kubernetes, ECS) reiniciar todas as instâncias do app sem motivo, porque reiniciar não conserta o banco. O `ready` tira a instância do balanceador até o banco voltar. Provamos: com o Postgres parado, o `ready` responde 503 e o `live` continua 200. Quando o Postgres volta, o `ready` volta a 200 sozinho.
- **"Por que não LocalStack, já que o enunciado cita?"** O enunciado aceita LocalStack **ou** MiniStack. O LocalStack atual exige token, o que impediria o avaliador de rodar só com `docker compose up`. Validamos FIFO e DLQ no MiniStack antes de adotar.
- **"Você confia na FIFO para não processar em dobro?"** Não. A deduplicação da FIFO vale por 5 minutos e só para o mesmo `MessageDeduplicationId`. A garantia vai estar no banco: unique constraints + inbox (Fases 2, 3 e 6).
- **"O que acontece se o MiniStack demorar para criar as filas?"** O healthcheck do container só fica "healthy" quando a fila principal (a última criada) existe. Por isso o app nunca sobe antes das filas.

### Arquivos principais da fase

- `package.json`: dependências e scripts (`start`, `test`, `typecheck`, `migration:up/down`).
- `tsconfig.json`: modo strict + decorators para o NestJS.
- `src/main.ts`: sobe o Nest e liga os hooks de desligamento (SIGTERM).
- `src/app.module.ts`: registra o MikroORM e o cliente SQS para injeção.
- `src/mikro-orm.config.ts`: conexão com o Postgres e a pasta das migrations.
- `src/health/health.controller.ts`: endpoints de liveness e readiness.
- `scripts/migrate.ts`: roda migrations up/down sem a CLI do MikroORM.
- `ministack/init/01-create-queues.sh`: cria a DLQ e a fila principal com redrive.
- `docker-compose.yml` / `Dockerfile`: sobem tudo com versões fixas.
- `.env.example`: variáveis para rodar app e testes fora do Docker.
- `test/health.test.ts`: teste de integração dos dois health checks.

---

## Fase 1 — Domínio puro (sem banco)

### O que foi feito

- As regras de dinheiro, wallet, transação, ledger, inbox, outbox e eventos ficaram em classes TypeScript puras, em `src/domain/`. Elas não importam nada do NestJS nem do MikroORM.
- Toda classe tem construtor privado e factories (`create`/`open`/`from` para coisas novas, `rehydrate` para o que vem do banco, sem revalidar).
- `Money` usa `decimal.js`, nunca `number`. A entrada exige string com **exatamente 2 casas** ("25.00") e nada é arredondado.
- A lista de `failureCode` (o código que explica cada rejeição) ficou definida, e as transições de status são explícitas, com estados terminais.
- 74 testes unitários cobrem os itens "Unidade" do enunciado.

### Fluxo (como o caso de uso da Fase 3 vai usar essas peças)

`WagerTransaction.create (valida kind, valor > 0, referência) → [se REFUND/ROLLBACK] checkReference(ref) → wallet.debit/credit (cria o lançamento e só então muda saldo e version) → tx.markProcessed → eventos (Processed + BalanceChanged) → OutboxMessage.enqueue`

Se faltar saldo: `wallet.debit lança InsufficientBalanceError → tx.reject(tx.insufficientBalanceCode()) → evento Rejected`

### Conceitos novos

- **Value Object (Money).** Um objeto definido pelo valor, não por identidade, e imutável: somar devolve um **novo** Money.
  *Analogia:* uma nota de R$ 10 não "vira" R$ 15. Você recebe outra quantia.
- **Aggregate Root (Wallet).** A wallet é a única porta para mudar o saldo. Saldo, version e lançamento do ledger mudam juntos, num método só (`apply`). Assim não tem como alterar o saldo e esquecer o ledger.
  *Analogia:* o caixa do banco. Você não mexe no cofre direto, pede ao caixa, e ele sempre registra no livro.
- **Máquina de estados com estados terminais.** `PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`, e `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Depois de terminal, qualquer transição lança `InvalidTransactionStateError`, que indica bug no código e não regra de negócio.
  *Analogia:* um pedido entregue não volta para "em preparo".
- **JSON canônico + SHA-256.** Ordenar as chaves antes de gerar o hash faz `{a,b}` e `{b,a}` terem o mesmo hash. É assim que distinguimos "mesma requisição repetida" (replay) de "mesma chave com conteúdo diferente" (conflito).
- **Backoff exponencial.** Cada nova tentativa espera o dobro da anterior (1s, 2s, 4s…) até um teto (5 min).
  *Analogia:* ligar de novo para alguém que não atende, esperando cada vez mais entre as ligações.

### Decisões e alternativas descartadas

- **Formato do valor: exatamente 2 casas** (decisão do Gabriel, opção A). `"0.30"` e `"0.00"` passam; `"25"`, `"25.5"`, `"0.0"`, `"0,30"` e `"1.005"` são rejeitados. Descartamos aceitar de 0 a 2 casas e normalizar: seria mais permissivo, mas o README fala em escala fixa, e uma regra mais simples é mais fácil de defender.
- **Valor de transação sempre maior que zero** (decisão do Gabriel). Ganhar ou apostar 0 não existe; empate chega como `WIN` com o valor devolvido. Zero só é válido como **saldo** (wallet aberta com 0.00 ou que gastou tudo). O saldo nunca fica negativo.
- **Duas armadilhas do decimal.js, encontradas lendo a documentação e evitadas:**
  1. `isPositive()` devolve `true` para zero. Usamos `gt(0)`. Validamos quebrando isso de propósito: 3 testes falharam.
  2. A precisão padrão é de 20 dígitos significativos, o que arredondaria em silêncio a soma de valores grandes. Usamos `Decimal.clone({ precision: 40 })` e limitamos a entrada a 18 dígitos inteiros, para caber em `NUMERIC(20,2)`.
- **`Wallet.open` devolve a wallet + o lançamento de abertura.** O README pede version 1 depois da criação e diz que toda alteração de saldo tem lançamento. Se abrir com 0 e depois chamar `credit`, a version iria para 2. Por isso a wallet nasce com o saldo inicial e version 1, e o lançamento OPENING sai junto.
- **O lançamento é criado antes de mudar o saldo.** Se a validação do lançamento falhar, a wallet continua intacta.
- **"Já revertida" não é checado no domínio.** Num único processo seria fácil, mas com várias instâncias só o banco garante, via unique constraint (Fase 2/3). O código `ALREADY_REVERSED` já existe na lista.
- **Mesmo "saldo insuficiente", dois códigos.** `INSUFFICIENT_FUNDS` para aposta e `REVERSAL_WOULD_OVERDRAW` para um ROLLBACK de crédito que o jogador já gastou (regra 9 do enunciado).
- **Id da mensagem na outbox = eventId.** Se o publisher publicar duas vezes, o consumidor deduplica pelo mesmo id.
- **Outbox sem limite de tentativas.** Um evento confirmado no banco não pode ser descartado. O teto de 5 min evita sobrecarregar o SQS fora do ar, e a métrica de outbox lag (Fase 8) mostra o atraso.
- **IDs UUIDv7 (`Bun.randomUUIDv7()`).** São ordenados pelo tempo, o que é bom para índice no banco e para a paginação por cursor (Fase 4).
- **Factory `opening()` da transação OPENING adiada para a Fase 4**, onde é usada. Nesta fase o `create` só recusa OPENING vindo de fora.
- **Ponto em aberto para a Fase 3:** se a referência existe mas ainda está `PENDING`/`PENDING_REFERENCE`, a transação deve esperar (PENDING_REFERENCE) e não ser rejeitada. Hoje `checkReference` devolve `REFERENCE_NOT_PROCESSED` para qualquer status diferente de PROCESSED. O caso de uso vai tratar "referência ainda não terminal" antes de chamar.

### Perguntas prováveis da banca

- **"Por que não usar `number` com `toFixed(2)`?"** Porque `number` é ponto flutuante binário: `0.1 + 0.2 = 0.30000000000000004`. Há um teste provando que com `Money` dá exatamente `0.30`. E `toFixed` arredonda, o que esconderia o erro em vez de evitar.
- **"O que acontece se chegar `"10.005"`?"** É rejeitado como entrada inválida (HTTP 400). Nunca arredondamos dinheiro sem avisar: decidir arredondar é regra de negócio, não detalhe técnico.
- **"Como você garante que o ledger é imutável?"** Em três camadas: (1) a classe não tem setters nem métodos de mudança, só campos `readonly`; (2) o objeto é congelado (`Object.freeze`), e o teste prova que atribuir lança erro; (3) no banco, um trigger bloqueia UPDATE/DELETE (Fase 2).
- **"Por que ROLLBACK de WIN sem saldo não é `INSUFFICIENT_FUNDS`?"** São situações diferentes para a operação. Aposta sem saldo é normal, o jogador só não tem dinheiro. Reversão sem saldo significa que o crédito já foi gasto e pede investigação. Códigos distintos permitem alertas distintos.

### Arquivos principais da fase

- `src/domain/money.ts`: valor monetário exato e imutável, com validação do contrato de entrada.
- `src/domain/wallet.ts`: aggregate root; único lugar que muda saldo, sempre junto com o lançamento.
- `src/domain/wallet-ledger-entry.ts`: lançamento imutável que confere a própria aritmética.
- `src/domain/wager-transaction.ts`: tipos, status, transições e regras de referência por kind.
- `src/domain/failure-code.ts`: lista de códigos de rejeição, cada um com a sua explicação.
- `src/domain/errors.ts`: erros do domínio (entrada inválida, moeda, saldo, estado).
- `src/domain/payload-hash.ts`: JSON canônico + SHA-256 para a idempotência.
- `src/domain/events.ts`: envelope abstrato + 4 eventos de integração.
- `src/domain/inbox-message.ts` / `outbox-message.ts`: deduplicação de entrada e publicação com backoff.
- `test/unit/*.test.ts`: 74 testes unitários.

---

## Fase 2 — Schema e migrations

### O que foi feito

- Uma migration escrita à mão em SQL cria as 5 tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`. O `down` remove tudo.
- As garantias do enunciado (unicidade, saldo nunca negativo, ledger imutável) estão **no banco**, por constraints e trigger. Valem mesmo se o código da aplicação tiver bug.
- Entraram dois códigos de falha novos: `WALLET_NOT_FOUND` e `WALLET_PLAYER_MISMATCH`.
- 25 testes de integração contra o Postgres real. Cada um tenta violar uma regra e confere que o banco recusa, com o código de erro e o nome da constraint.

### Fluxo

`bun run migration:up → MikroORM lê src/database/migrations → aplica as que faltam (em transação) → registra em mikro_orm_migrations`

No Docker: `docker compose up → app roda migration:up → sobe o Nest`. Validado subindo do zero, com o volume apagado.

### Conceitos novos

- **Constraint.** Uma regra que o próprio banco garante. Se alguém tentar gravar algo que a viola, o banco recusa a operação inteira.
  *Analogia:* a catraca do metrô. Não importa o que você diga ao segurança: sem bilhete, ela não gira.
- **Unique parcial** (`CREATE UNIQUE INDEX ... WHERE ...`). A unicidade vale só para as linhas que atendem a condição. Usamos para "uma referência só pode ser revertida uma vez", contando apenas REFUND e ROLLBACK.
- **FK composta** (`(wallet_id, currency) → wallets(id, currency)`). O lançamento só existe se houver uma wallet com aquele id **e** aquela moeda. Assim, o banco impede um lançamento em USD numa wallet BRL.
- **Trigger.** Uma função que o banco executa sozinho antes ou depois de uma operação. O nosso trigger recusa UPDATE, DELETE e TRUNCATE no ledger.
  *Analogia:* livro-caixa escrito a caneta. Errou, faz um lançamento de estorno, não apaga.
- **SQLSTATE.** O código padrão de erro do Postgres: `23505` para unique, `23514` para check, `23503` para FK e `P0001` para erro lançado por função. Os testes conferem o código exato.

### Decisões e alternativas descartadas

- **Migration escrita à mão, não gerada pelo ORM.** O gerador do MikroORM cria tabelas a partir das entidades, mas não sabe fazer CHECK com regra de negócio, unique parcial nem trigger. E é isso que o enunciado avalia.
- **Reversão única por referência, de qualquer tipo** (decisão do Gabriel, opção A). O enunciado proíbe reverter duas vezes "pelo mesmo tipo". Ao pé da letra, uma BET poderia receber REFUND **e** ROLLBACK, creditando duas vezes. Nosso índice `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK')` é mais rígido e continua cumprindo a regra 4. Fazer ROLLBACK de um REFUND continua permitido, porque a referência é outra.
- **Transação para wallet inexistente é gravada como REJECTED `WALLET_NOT_FOUND`** (decisão do Gabriel, opção 2). A primeira proposta era rejeitar sem gravar, e foi descartada por três motivos:
  1. Um reenvio depois que a wallet fosse criada seria processado: a mesma requisição teria dois resultados, o que contraria a regra 7.
  2. HTTP e fila se comportariam diferente, porque o inbox da fila grava a mensagem como vista e o HTTP não gravaria nada.
  3. Não ficaria rastro para auditoria.

  Custo: `wager_transactions.wallet_id` não tem FK. Não abre buraco, porque dinheiro só se move pelo ledger, e o ledger tem FK para a wallet.
- **`WALLET_PLAYER_MISMATCH`**: a wallet existe, mas pertence a outro jogador. É rejeição definitiva e tem código próprio, porque indica bug ou fraude no provedor.
- **O banco confere a aritmética do ledger** (`ledger_balanced`). A classe `WalletLedgerEntry` já confere, mas a regra fica também no banco, como segunda camada.
- **Coerência entre status e campos** (REJECTED exige `failure_code`, PROCESSED exige `processed_at`). Impede gravar um estado "meio preenchido".
- **Tipos:** ids internos são `uuid`; ids externos (player, provider, round, game, message) são `text`, porque o formato é do provedor. Dinheiro é `numeric(20,2)` + `char(3)`. O payload da outbox é `jsonb`.
- **Índices pensados para as consultas das próximas fases:** `(wallet_id, id)` para o extrato paginado por cursor, e `outbox_pending_idx` parcial para o publisher, que só lê pendentes.
- **As colunas do worker de PENDING_REFERENCE (`attempts`, `next_attempt_at`) ficaram para uma 2ª migration, na Fase 7.** Isso mostra na prática o versionamento.
- **Testes provam que testam:** removemos de propósito o `UNIQUE` do índice de reversão e os 2 testes de reversão falharam. Depois restauramos.
- **Limitações conhecidas:**
  - O teste de migration derruba e recria o schema, apagando os dados do banco de desenvolvimento.
  - Um superusuário do Postgres consegue desligar triggers. Em produção, o app rodaria com um usuário sem permissão de alterar tabelas.

### Perguntas prováveis da banca

- **"Se o código já valida, por que repetir no banco?"** Com várias instâncias e vários caminhos de escrita (HTTP, fila, worker), basta um bug ou uma corrida entre processos para o código deixar passar. O banco é o único ponto que **todas** as instâncias compartilham, então é lá que a garantia é absoluta. O enunciado exige isso explicitamente (restrição 9).
- **"Como você impede que alguém apague um lançamento do ledger?"** Com um trigger que recusa UPDATE, DELETE e TRUNCATE, com teste provando os três. Correções viram **novos** lançamentos (ROLLBACK), nunca edição.
- **"Por que a tabela de transações não tem FK para wallets?"** Porque queremos gravar a rejeição `WALLET_NOT_FOUND` para manter a idempotência: todo reenvio devolve a mesma resposta. A segurança financeira não depende dessa FK, porque o ledger tem FK para a wallet e nenhum dinheiro se move sem lançamento.
- **"Um provedor pode fazer REFUND e depois ROLLBACK da mesma aposta?"** Não. O índice único parcial permite uma reversão por referência, e há teste provando que o ROLLBACK depois do REFUND é recusado pelo banco.

### Arquivos principais da fase

- `src/database/migrations/Migration20261122000000_InitialSchema.ts`: cria e remove todo o schema, com as constraints comentadas.
- `src/domain/failure-code.ts`: ganhou `WALLET_NOT_FOUND` e `WALLET_PLAYER_MISMATCH`.
- `test/integration/schema.test.ts`: 25 testes de integração (migration up e down, mais cada constraint).

---

## Fase 3 — Caso de uso principal (o coração)

### O que foi feito

- Criei o `ProcessWagerTransaction`, o caso de uso que o HTTP (Fase 4) e a fila (Fase 6) vão chamar. Ele aplica BET, WIN, LOSS, REFUND e ROLLBACK, com idempotência e PENDING_REFERENCE.
- Tudo numa transação SQL só: transação + saldo + ledger + eventos na outbox (+ inbox, quando vier da fila). Ou grava tudo, ou nada.
- **Concorrência:** lock pessimista **por linha da wallet** (`SELECT ... FOR UPDATE`, via `LockMode.PESSIMISTIC_WRITE` do MikroORM).
- **Persistência (opção C, decisão do Gabriel):** classes "record" só de banco, mapeadas por `EntitySchema`, mais um conversor record ↔ domínio. O caso de uso fala com uma **porta** (`WagerStore`), não com o MikroORM.
- Uma 2ª migration guarda o **saldo observado** em cada transação (regra 7: o replay devolve o saldo daquele momento).
- 20 testes de integração com paralelismo real, incluindo o cenário obrigatório e a mesma BET 50x.

### Fluxo

`valida entrada (formato, UUID, kind) → calcula payloadHash → BEGIN + SET LOCAL lock_timeout = 5s → [inbox, se veio da fila] → SELECT wallet FOR UPDATE (trava só ela) → busca idempotency key (depois do lock!) → existe? mesmo hash = replay / hash diferente = conflito → wallet existe? é do jogador? mesma moeda? → tem referência? não achou ou pendente = PENDING_REFERENCE / já revertida = ALREADY_REVERSED / inválida = código → LOSS? marca PROCESSED sem ledger → debit/credit (sem saldo = INSUFFICIENT_FUNDS ou REVERSAL_WOULD_OVERDRAW) → grava transação (flush) → UPDATE saldo + version → INSERT ledger → INSERT outbox → COMMIT → resposta`

### Conceitos novos

- **Lock pessimista (`SELECT ... FOR UPDATE`).** A primeira transação que lê a wallet "segura" a linha até o commit. As outras que querem a **mesma** wallet esperam na fila; wallets diferentes seguem em paralelo.
  *Analogia:* o provador da loja. Uma pessoa por vez em cada provador, mas os outros provadores continuam funcionando.
- **Lost update.** Duas transações leem saldo 100, cada uma debita 80 e grava 20. Uma escrita "some" e o dinheiro aparece do nada. **Provamos isso:** sem o lock, os testes falharam com `balance 30.00 != ledger 15.00`.
- **Por que checar a idempotência DEPOIS do lock.** Se duas cópias da mesma requisição checassem antes, as duas veriam "não existe" e as duas processariam. Depois do lock, a segunda só passa quando a primeira já fez commit, então ela enxerga a primeira e vira replay.
- **Unit of Work e Identity Map (MikroORM).** O `em` guarda as entidades carregadas (Identity Map) e rastreia as mudanças. No `flush`, gera os INSERT e UPDATE necessários (Unit of Work). Cada execução usa um `em.fork()` próprio, para nunca ver dados de outra requisição.
- **Porta e adaptador.** O caso de uso depende de uma interface (`WagerStore`); o Postgres é só uma implementação. Isso permitiu o teste de atomicidade: um "store que falha antes do commit", sem mexer no caso de uso.
- **`lock_timeout`.** Se uma wallet "quente" deixa alguém esperando mais de 5s, a espera vira erro transitório (503 na Fase 4, o cliente reenvia), em vez de prender conexões para sempre.

### Decisões e alternativas descartadas

- **Lock pessimista, e não otimista (`version` + retry).** Numa wallet muito disputada, o otimista faz quase todo mundo falhar e repetir. O pessimista põe todo mundo em fila e resolve de primeira. O custo é a espera, limitada pelo `lock_timeout`. A `version` continua sendo incrementada (pedido do enunciado) e serve de auditoria.
- **Sem deadlock por construção:** cada transação trava **uma** linha (a wallet). Deadlock exige duas transações travando duas coisas em ordem inversa.
- **Persistência opção C** (records + conversor), escolhida pelo Gabriel entre: (A) SQL explícito, que usaria pouco o ORM "preferencial"; (B) `EntitySchema` direto no domínio, de alto risco, porque o `Money` ocupa duas colunas e os campos são privados; (C) records, que usam Unit of Work, Identity Map e LockMode sem sujar o domínio. A rede de segurança de 30 min para voltar à (A) não foi necessária.
- **Flush da transação antes do ledger.** O lançamento tem FK para a transação. Além disso, o flush antecipado faz a unique constraint de idempotência aparecer ali, e ela vira `DuplicateTransactionError` com uma repetição automática, que vira replay. Isso cobre o caso sem lock (`WALLET_NOT_FOUND`): 20 cópias em paralelo geram uma única linha.
- **Defesa em camadas, observada no teste:** mesmo **sem** o lock, a "mesma BET 50x" continuou debitando uma vez só, porque a unique da idempotency key barrou as cópias. O lock protege o **saldo**; a constraint protege a **duplicata**.
- **`isAlreadyReversed` checado com o lock da wallet** (a referência é da mesma wallet, então a checagem é confiável). O índice único da Fase 2 é a última barreira. O teste "10 REFUNDs concorrentes" resulta em 1 PROCESSED e 9 ALREADY_REVERSED.
- **Referência existente, mas ainda pendente, vira PENDING_REFERENCE** (não rejeição). Isso fecha o ponto em aberto da Fase 1.
- **Saldo observado guardado na transação** (2ª migration, colunas `observed_balance_*`). A moeda tem coluna própria porque, em `CURRENCY_MISMATCH`, o saldo está na moeda da wallet.
- **Validação de `walletId` como UUID no caso de uso:** sem ela, um id malformado viraria erro de SQL (500) em vez de entrada inválida (400).
- **Snapshot do MikroORM desligado** (`snapshot: false`). Ele só serve para gerar migrations automaticamente, e as nossas são escritas à mão.
- **Testes:**
  - Eles provam que testam: tirando o lock, 4 testes falham com lost update.
  - Achei e corrigi no próprio teste um `expect(...).rejects` sem `await`, que passaria sem verificar nada.
  - Todos terminam conferindo `saldo == ledger`.

### Perguntas prováveis da banca

- **"Como você garante que duas apostas simultâneas não deixam o saldo negativo?"** O `SELECT ... FOR UPDATE` coloca as transações da mesma wallet em fila: a segunda só lê o saldo depois do commit da primeira, e aí vê 20 e rejeita. E se mesmo assim algo escapasse, o `CHECK (balance >= 0)` do banco recusaria. Teste: 30 apostas de 7.00 em paralelo num saldo de 100 resultam em exatamente 14 processadas e saldo 2.00.
- **"E com várias instâncias da aplicação?"** O lock é do **Postgres**, não da memória do processo. Todas as instâncias usam o mesmo banco, então a fila por wallet vale entre processos. Teste com 3+ processos na Fase 9.
- **"O que acontece se o processo morrer no meio?"** Antes do commit, o Postgres desfaz tudo (rollback), e há teste simulando a falha: nada fica gravado, nem transação, nem saldo, nem ledger, nem outbox, nem inbox. Depois do commit, tudo está gravado junto, inclusive o evento na outbox, que será publicado depois (Fase 5).
- **"Por que não usar lock otimista, que o enunciado sugere com o `version`?"** Numa hot wallet, o otimista vira uma tempestade de retries. O enunciado aceita outra estratégia, desde que justificada. A `version` continua lá e incrementa só quando o saldo muda.

### Arquivos principais da fase

- `src/application/process-wager-transaction.ts`: o caso de uso, com a ordem das checagens comentada.
- `src/application/wager-store.ts`: a porta (interfaces) e os erros de aplicação (duplicata, conflito de idempotência).
- `src/infrastructure/persistence/records.ts`: classes de banco + `EntitySchema`.
- `src/infrastructure/persistence/postgres-wager-store.ts`: adaptador MikroORM (fork, transactional, LockMode, flush, conversão).
- `src/database/migrations/Migration20261122010000_ObservedBalance.ts`: colunas do saldo observado.
- `src/mikro-orm.config.ts`: registra os schemas e desliga o snapshot.
- `test/integration/helpers.ts`: cria wallets com lançamento de abertura e confere o invariante `saldo == ledger`.
- `test/integration/process-wager-transaction.test.ts`: 20 testes (concorrência, idempotência, regras, atomicidade).

---

## Fase 4 — API HTTP

### O que foi feito

- Criei todos os endpoints da seção 9 do enunciado: criar e consultar wallet, extrato paginado por cursor, submeter e consultar transação (pelo id interno e pelo id do provedor) e reconciliação.
- `POST /wallets` cria wallet + transação `OPENING` + lançamento CREDIT + eventos, **na mesma transação SQL** (caso de uso `CreateWallet`).
- O mapeamento de status HTTP fica num lugar só, o filtro de erros, por isso é igual em todos os endpoints.
- Criei o `AuthGuard` no-op como ponto de extensão da autenticação.
- 18 testes pela HTTP real, mais um teste manual com `curl` no app rodando no Docker.

### Fluxo

`Requisição → AuthGuard (no-op) → controller valida o formato (400) → caso de uso → resultado: PROCESSED=200 / PENDING_REFERENCE=202 / REJECTED=422 → [erro?] HttpErrorFilter: entrada inválida=400, conflito=409, transitório=503, inesperado=500`

### Conceitos novos

- **Paginação por cursor x por OFFSET.** Com `OFFSET 50`, se um lançamento novo entra enquanto o cliente lê, as páginas "andam" e itens se repetem ou somem. Com o cursor ("me dê os depois do id X"), a próxima página começa exatamente onde a anterior parou. Funciona porque o id é UUIDv7 (cresce com o tempo) e o ledger é append-only.
  *Analogia:* marcador de livro (cursor) x "página 50" num livro em que alguém continua inserindo páginas.
- **Cursor opaco.** O cliente recebe uma string codificada (base64url do id) e só a devolve. Assim podemos mudar o formato interno sem quebrar ninguém.
- **Exception filter (NestJS).** Um único ponto que pega qualquer erro e decide o status. Os controllers não têm `try/catch` espalhado.
- **Erro transitório x permanente.** Transitório é aquilo que, tentando de novo, pode dar certo (banco reiniciando, lock demorando): responde **503** com `retryable: true`. Permanente é aquilo que, tentando de novo, dá o mesmo resultado: 400, 409, 422.

### Decisões e alternativas descartadas

- **Mesmo status na primeira vez e no replay** (decisão do Gabriel): PROCESSED é sempre 200, rejeição é sempre 422. O enunciado pede "requisição idêntica → mesma resposta". Usar 201 e depois 200 mudaria a resposta. Quem diferencia é o campo `idempotentReplay`. Só a criação de wallet é 201, porque ela não tem replay.
- **Rejeição de negócio é resultado, não exceção.** O caso de uso devolve `REJECTED` + `failureCode` normalmente, e o controller responde 422 com o corpo completo (transactionId, failureCode, saldo). Assim o provedor tem tudo para decidir.
- **Campo `retryable` nos erros:** o provedor decide se pode reenviar sem interpretar a mensagem (o enunciado pede isso explicitamente).
- **O MikroORM 7 não tem exceção própria para lock timeout (`55P03`).** Descobri lendo o conversor de erros do MikroORM: o erro chega como `DriverException` genérica. A função `isTransientDbError` classifica pelo código SQLSTATE (lock, deadlock, Postgres reiniciando, conexão). Ela vai ser reaproveitada na fila (Fase 6), para decidir entre retry e DLQ.
- **Id malformado na URL responde 404 (não existe), e não 500.** Sem a checagem, o Postgres daria erro de sintaxe de UUID.
- **Consultas só de leitura (`PostgresQueries`) não passam pelo domínio:** não mudam estado, só montam a resposta.
- **Reconciliação não corrige:** ela mede, loga um aviso e devolve `consistent: false`. Corrigir em silêncio esconderia o bug que causou a divergência. Testado: depois da reconciliação, o saldo continua divergente, esperando investigação.
- **Abertura de wallet emite `WagerTransactionProcessed` (OPENING) e `WalletBalanceChanged`** (o saldo foi de 0 para o valor inicial). Wallet aberta com 0 não gera transação, lançamento nem evento.
- **Casos de uso continuam sem decorators do Nest.** O `app.module.ts` os monta com `useFactory`. O NestJS fica só na borda (controllers, filtro, guard).
- **O teste de 503 testa a função de mapeamento diretamente.** Derrubar o banco no meio de um teste HTTP seria lento e instável; a queda real do Postgres entra no teste de reinício (Fase 9).

### Perguntas prováveis da banca

- **"Como o provedor sabe se pode reenviar?"** Pelo status: 503 = sim, com a mesma Idempotency-Key (é seguro, porque vira replay); 400, 409 e 422 = não adianta reenviar igual. O corpo também traz `retryable`.
- **"Por que 422 e não 400 para saldo insuficiente?"** 400 significa "seu payload está mal formado". 422 significa "o payload está certo, mas a regra de negócio recusou". Se os dois usassem o mesmo código, o provedor teria que ler a mensagem para saber se o erro é dele ou do saldo do jogador.
- **"Por que paginação por cursor?"** Porque o extrato cresce enquanto é lido. Com OFFSET, itens se repetiriam ou sumiriam entre as páginas. O teste insere um lançamento **no meio** da paginação e prova que nenhum item é repetido ou perdido.
- **"E a autenticação?"** Não foi implementada (vale 0 pontos), mas o ponto de extensão existe (`AuthGuard`), e o desenho com Keycloak (JWT do provedor, validação por JWKS, `providerId` do token = `providerId` do corpo) vai no `ARCHITECTURE.md`.

### Arquivos principais da fase

- `src/application/create-wallet.ts`: cria wallet + OPENING + ledger + eventos numa transação.
- `src/domain/wager-transaction.ts`: ganhou a factory `opening()`.
- `src/domain/wallet.ts`: `openingTransactionId` virou opcional (só é exigido com saldo > 0).
- `src/domain/uuid.ts`: validação de UUID compartilhada.
- `src/application/wager-store.ts`: a porta ganhou `addWallet` e o erro `WalletAlreadyExistsError`.
- `src/infrastructure/persistence/postgres-wager-store.ts`: implementa o `addWallet` (unique → 409).
- `src/infrastructure/persistence/postgres-queries.ts`: leituras, extrato por cursor e reconciliação.
- `src/infrastructure/persistence/transient-errors.ts`: decide o que é falha transitória.
- `src/http/http-error.filter.ts`: erro → status HTTP, num lugar só.
- `src/http/wallets.controller.ts` / `wagering.controller.ts`: os endpoints e a validação de formato.
- `src/http/auth.guard.ts`: o ponto de extensão da autenticação.
- `src/app.module.ts`: monta tudo.
- `test/integration/http.test.ts`: 18 testes pela HTTP real.

### Correção depois da Fase 4: corrida entre duas consultas (bug da Fase 3)

- **Sintoma:** o teste "mesma transação para wallet inexistente, 20x em paralelo" passou a falhar sempre, com `IdempotencyConflictError` ("externalTransactionId já usado com outra key"), mas a key era a mesma.
- **Causa raiz:** no caminho **sem lock** (wallet não existe), o caso de uso fazia duas consultas seguidas: pela key e depois pelo id externo. No Postgres (nível READ COMMITTED), **cada SELECT enxerga os commits feitos até ele**. A cópia concorrente fazia commit entre as duas: a 1ª não achava nada, a 2ª achava, e o código concluía errado que era conflito. Antes o teste passava por sorte de tempo.
- **Correção:** se a busca pelo id externo encontra a transação, comparo a key. Mesma key = mesma transação (replay, com checagem do hash); key diferente = conflito. Rodei o teste 8x isolado e a suíte inteira 3x, tudo verde.
- **Lição para a banca:** sem lock, "consultar e depois decidir" é uma corrida. Com a wallet travada isso não acontece, porque tudo depois do lock é serializado. No caminho sem lock, a decisão precisa considerar que o mundo mudou entre uma consulta e outra, e a unique constraint continua como última barreira.
- **Helper de testes (decisão do Gabriel: "se quebrar, volta"):** tentamos trocar o helper que cria wallets pelo `CreateWallet` real. Ele funcionou, mas 2 testes contavam com a outbox vazia, e agora a abertura grava eventos (corretamente). Pela regra combinada com o Gabriel ("se quebrar, volta"), o helper voltou para o SQL direto.

---

## Fase 5 — Outbox publisher

### O que foi feito

- `OutboxPublisher`: um worker **dentro do app** (decisão do Gabriel) que, a cada ~500 ms, publica no SQS os eventos já commitados na outbox.
- Ele é seguro com várias instâncias: cada rodada usa `SELECT ... FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE` no MikroORM).
- Se o SQS falha, o evento continua pendente e volta com backoff exponencial (a lógica do `OutboxMessage.scheduleRetry`, da Fase 1).
- Criei a fila de saída `wallet-events.fifo`, separada da fila de entrada de comandos. O readiness agora checa as 3 filas.
- O worker liga junto com o app e para com segurança no shutdown (termina a rodada atual antes de sair).
- 4 testes de integração com Postgres e SQS reais.

### Fluxo

`a cada 500ms → BEGIN → SELECT até 10 eventos pendentes e vencidos FOR UPDATE SKIP LOCKED → para cada um: SendMessage (MessageGroupId = aggregateId, MessageDeduplicationId = eventId) → ok: published_at = agora / falhou: attempts + 1 e next_attempt_at = agora + backoff → COMMIT`

### Conceitos novos

- **Transactional Outbox.** O evento é gravado na **mesma transação** da mudança financeira (Fase 3) e só é publicado **depois** do commit, por este worker. Assim nunca existe "evento publicado de uma operação que deu rollback", nem "operação confirmada cujo evento se perdeu".
  *Analogia:* o recibo é impresso junto com a venda e fica na gaveta. O entregador passa depois e leva todos os recibos que estão na gaveta. Se ele faltar um dia, os recibos continuam lá.
- **`FOR UPDATE SKIP LOCKED`.** Trava as linhas que pegou e faz as outras instâncias **pularem** essas linhas, em vez de esperar. Cada publisher pega um lote diferente.
  *Analogia:* vários caixas atendendo uma fila; cada cliente vai para um caixa só, e ninguém fica parado esperando o caixa do lado.
- **At-least-once.** Se o processo morrer depois do `SendMessage` e antes do `COMMIT`, a linha volta a ficar pendente e o evento é publicado de novo. Duplicata é possível **por desenho**. O consumidor deduplica pelo `eventId` (que também é o id da mensagem). Entregar "exatamente uma vez" entre banco e fila não é possível sem uma transação distribuída.

### Decisões e alternativas descartadas

- **Worker dentro do app, e não num processo separado** (decisão do Gabriel): é mais simples e já escala com as instâncias, graças ao `SKIP LOCKED`. Um processo separado escalaria de forma independente, mas seria mais um serviço no compose.
- **A transação SQL fica aberta durante o `SendMessage`.** É simples: o lock da linha garante que ninguém mais publica aquele evento enquanto ela está sendo enviada. O custo é segurar uma conexão por alguns milissegundos por lote. Limitamos o lote a 10 e o envio a um timeout de 5s. A alternativa, que é "reservar" a linha com uma coluna de lease e publicar fora da transação, aguenta mais volume, mas é mais complexa. Fica registrada como evolução.
- **Fila de saída separada (`wallet-events.fifo`):** publicar eventos na fila de entrada faria o serviço consumir a própria saída.
- **`MessageGroupId = aggregateId`:** mantém a ordem dos eventos de uma mesma wallet ou transação. **`MessageDeduplicationId = eventId`:** o SQS descarta duplicatas por 5 min. É só otimização; a garantia é o consumidor deduplicar pelo `eventId`.
- **Sem limite de tentativas:** evento confirmado no banco não pode ser descartado (decisão da Fase 1). O backoff vai até 5 min entre tentativas.
- **Lote cheio = segue direto, sem dormir:** se havia 10 eventos, provavelmente há mais esperando.
- **Testes provam que testam:** tirando o `SKIP LOCKED`, dois publishers enviaram **60 mensagens para 30 eventos** (cada um duplicado). Com ele, 30 de 30, sem repetição.
- **Restrição do ambiente de teste:** o container `app` também roda um publisher no mesmo banco. Durante o `bun test` ele precisa estar parado (`docker compose stop app`), senão disputa os eventos com os testes. O teste avisa com uma mensagem clara. Vai no README.

### Perguntas prováveis da banca

- **"O que acontece se o processo morrer depois do commit e antes de publicar?"** O evento está gravado na outbox, com `published_at` vazio. Qualquer instância (essa mesma depois de reiniciar, ou outra) o publica na próxima rodada. Teste: commit feito, nenhum publisher roda (a instância "morreu"), um publisher novo sobe e publica.
- **"E se publicar e morrer antes de marcar como publicado?"** O evento sai de novo (at-least-once). É seguro porque o id é estável (`eventId`) e o consumidor deduplica. Exatamente-uma-vez entre Postgres e SQS exigiria uma transação distribuída, que nenhum dos dois oferece.
- **"Como dois publishers não mandam o mesmo evento?"** Pelo `FOR UPDATE SKIP LOCKED`: a linha travada por um é invisível para o outro naquela rodada. Provado com 30 eventos e dois publishers (30 envios, nenhum repetido) e com o teste invertido (sem o lock: 60 envios).
- **"E se o SQS ficar fora do ar por uma hora?"** Nada se perde: os eventos acumulam na outbox, com backoff de até 5 min entre tentativas, e saem quando o SQS voltar. A métrica de outbox lag (Fase 8) mostra o atraso.

### Arquivos principais da fase

- `src/infrastructure/messaging/outbox-publisher.ts`: o worker (rodada com SKIP LOCKED, envio, backoff, start/stop).
- `src/app.module.ts`: registra o publisher (o Nest liga e desliga junto com o app).
- `ministack/init/01-create-queues.sh`: cria a fila `wallet-events.fifo`.
- `docker-compose.yml`: o healthcheck do MiniStack espera a última fila.
- `src/health/health.controller.ts`: o readiness checa as 3 filas.
- `test/integration/outbox-publisher.test.ts`: 4 testes (instância morta, dois publishers, SQS fora, loop em background).
