// Roda as migrations sem a CLI do MikroORM (a CLI espera Node + ts-node; aqui o Bun já executa TypeScript).
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config';

const command = process.argv[2];
if (command !== 'up' && command !== 'down') {
  console.error('usage: bun scripts/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(config);
try {
  const executed = command === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`migration:${command} ok, ${executed.length} migration(s) executed`);
} finally {
  await orm.close(true);
}
