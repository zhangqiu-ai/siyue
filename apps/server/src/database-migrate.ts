import { z } from 'zod';
import { createDatabasePool } from './adapters/postgres/database.js';
import { migrateDatabase } from './adapters/postgres/migrate.js';

// Separate process: production API must never receive this variable.
const schema = z.object({
  SIYUE_MIGRATION_DATABASE_URL: z.string().min(1),
  SIYUE_DATABASE_NAME: z.string().regex(/^siyue(?:_[a-z0-9_]+)?$/),
  SIYUE_ENVIRONMENT: z.enum(['development','test','staging','production']),
});
async function main() {
  const result = schema.safeParse(process.env);
  if (!result.success) throw new Error('invalid_migration_config');
  const config = result.data;
  const pool = createDatabasePool(config.SIYUE_MIGRATION_DATABASE_URL, 1);
  try {
    const count = await migrateDatabase(pool, {database: config.SIYUE_DATABASE_NAME, environment: config.SIYUE_ENVIRONMENT});
    console.log(`Applied ${count} Siyue migration(s).`);
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Siyue migration failed; verify configuration, identity and migration history.'); process.exitCode = 1; });
