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
