import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { checkDatabaseIdentity, transaction, type DatabaseIdentity } from './database.js';

export const migrationDirectory = new URL('../../../migrations/', import.meta.url);
export async function readMigrations(directory: URL = migrationDirectory) {
  const names = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length || new Set(names.map(name => name.slice(0, 4))).size !== names.length) throw new Error('invalid_migration_manifest');
  return Promise.all(names.map(async version => {
    const sql = await readFile(new URL(version, directory), 'utf8');
    return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}
export async function migrateDatabase(pool: Pool, identity: DatabaseIdentity, directory?: URL) {
  const migrations = await readMigrations(directory);
  return transaction(pool, async client => {
    await checkDatabaseIdentity(client, identity, 'siyue_migrator');
    await client.query('SELECT pg_advisory_xact_lock(1936292213, 1)');
    await client.query('SET LOCAL ROLE siyue_owner');
    await client.query(`CREATE TABLE IF NOT EXISTS siyue.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const previous = (await client.query('SELECT version, checksum FROM siyue.schema_migrations ORDER BY version')).rows;
    if (previous.some((row, index) => migrations[index]?.version !== row.version || migrations[index]?.checksum !== row.checksum)) {
      throw new Error('migration_history_mismatch');
    }
    let applied = 0;
    for (const migration of migrations.slice(previous.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO siyue.schema_migrations(version,checksum) VALUES ($1,$2)', [migration.version, migration.checksum]);
      applied++;
    }
    // Application can inspect, never rewrite migration history.
    await client.query('REVOKE ALL ON siyue.schema_migrations FROM siyue_app');
    await client.query('GRANT SELECT ON siyue.schema_migrations TO siyue_app');
    return applied;
  });
}
export async function assertDatabaseReady(pool: Pool, identity: DatabaseIdentity) {
  const migrations = await readMigrations();
  return transaction(pool, async client => {
    await checkDatabaseIdentity(client, identity, 'siyue_app');
    const actual = (await client.query('SELECT version, checksum FROM siyue.schema_migrations ORDER BY version')).rows;
    if (actual.length !== migrations.length || actual.some((row, i) => row.version !== migrations[i]?.version || row.checksum !== migrations[i]?.checksum)) {
      throw new Error('database_schema_incompatible');
    }
  });
}
