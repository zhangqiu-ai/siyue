import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createDatabasePool } from '../../dist/adapters/postgres/database.js';
import { migrateDatabase } from '../../dist/adapters/postgres/migrate.js';

// Always creates a fresh cluster. Never reads a database URL or workspace .env.
export async function startPostgresFixture({migrate = true} = {}) {
  const bin = process.env.SIYUE_TEST_POSTGRES_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
  if (!existsSync(join(bin, 'initdb'))) throw Error('PostgreSQL binaries missing; set SIYUE_TEST_POSTGRES_BIN');
  // Short Unix socket path: PostgreSQL/macOS has a tight socket filename limit.
  const directory = mkdtempSync(join('/tmp', 'siyue-pg-'));
  const data = join(directory, 'data');
  const socket = join(directory, 'socket');
  mkdirSync(socket, {mode: 0o700});
  const appPassword = randomBytes(32).toString('hex');
  const migratorPassword = randomBytes(32).toString('hex');
  const pools = [];
  let started = false;
  const run = (name, args, env = {}) => execFileSync(join(bin, name), args, {
    env: {...process.env, LC_ALL: 'C', ...env}, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  function halt() {
    if (started) {run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); started=false;}
  }
  async function stop() {
    await Promise.all(pools.map(pool => pool.end()));
    halt();
    rmSync(directory, {recursive: true, force: true});
  }
  try {
    const share = join(realpathSync(bin), '..', 'share', 'postgresql');
    const resourceArgs = existsSync(join(share, 'postgres.bki')) ? ['-L', share] : [];
    run('initdb', [...resourceArgs, '-D', data, '--no-locale', '--encoding=UTF8', '--username=siyue_test_admin', '--auth-local=trust', '--auth-host=reject']);
    run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses='' -c max_connections=25`, '-w', 'start']);
    started = true;
    run('psql', ['-h', socket, '-U', 'siyue_test_admin', '-d', 'postgres', '-f', fileURLToPath(new URL('../../provision/independent-database.sql', import.meta.url))], {
      SIYUE_PROVISION_DATABASE: 'siyue_test', SIYUE_ENVIRONMENT: 'test',
      SIYUE_PROVISION_APP_PASSWORD: appPassword, SIYUE_PROVISION_MIGRATOR_PASSWORD: migratorPassword,
    });
    function poolFor(user, database = 'siyue_test') {
      const pool = createDatabasePool(`postgresql://${user}@localhost/${database}?host=${encodeURIComponent(socket)}`, 5);
      pools.push(pool); return pool;
    }
    const app = poolFor('siyue_app');
    const migrator = poolFor('siyue_migrator');
    const admin = poolFor('siyue_test_admin');
    const identity = {database: 'siyue_test', environment: 'test'};
    if (migrate) await migrateDatabase(migrator, identity);
    return {app, migrator, admin, identity, stop, halt, poolFor};
  } catch (error) {
    await stop();
    // Child errors can include SQL/password details; return only safe diagnosis.
    throw new Error(`Isolated PostgreSQL fixture failed: ${error.code ?? error.message?.split('\n')[0] ?? 'unknown'}`);
  }
}
