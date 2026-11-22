import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: [],
  // Fase 0 ainda não tem entidades; sem isso o MikroORM recusa iniciar.
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    // Caminho absoluto: funciona igual rodando da raiz, do Docker ou dos testes.
    path: `${import.meta.dir}/database/migrations`,
  },
});
