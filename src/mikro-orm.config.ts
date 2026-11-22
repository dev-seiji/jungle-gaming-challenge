import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ALL_SCHEMAS } from './infrastructure/persistence/records';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: ALL_SCHEMAS,
  extensions: [Migrator],
  migrations: {
    // Caminho absoluto: funciona igual rodando da raiz, do Docker ou dos testes.
    path: `${import.meta.dir}/database/migrations`,
    // Migrations são escritas à mão; o snapshot só serve para o gerador automático, que não usamos.
    snapshot: false,
    snapshotOnMigrate: false,
  },
});
