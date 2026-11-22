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
