import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { migrateDatabase, migrationDirectory, assertDatabaseReady, readMigrations } from '../../dist/adapters/postgres/migrate.js';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createRuntimeApp } from '../../dist/runtime-app.js';
import { readDatabaseConfig } from '../../dist/config.js';
let db;
before(async () => { db = await startPostgresFixture({migrate: false}); });
after(async () => { await db?.stop(); });

test('fresh and concurrent migration applies once; repeat is a no-op', async () => {
  const result = await Promise.all([migrateDatabase(db.migrator, db.identity), migrateDatabase(db.migrator, db.identity)]);
  assert.deepEqual(result.sort((a,b)=>a-b), [0, (await readMigrations()).length]);
  assert.equal(await migrateDatabase(db.migrator, db.identity), 0);
  await assertDatabaseReady(db.app, db.identity);
});

test('runtime is DML-only; metadata, DDL, ownership, roles and database creation denied', async () => {
  for (const sql of [
    'CREATE TABLE siyue.forbidden(id int)',
    'CREATE TABLE public.forbidden(id int)',
    'ALTER TABLE siyue.subjects ADD COLUMN forbidden int',
    'CREATE DATABASE forbidden', 'CREATE ROLE forbidden', 'SET ROLE siyue_owner',
    "UPDATE siyue.server_metadata SET environment='production'",
    "UPDATE siyue.schema_migrations SET checksum='forged'",
  ]) await assert.rejects(db.app.query(sql), error => error.code === '42501');
  const id = 'c7eec393-63cb-4d25-b78a-581dfdc4e78a';
  await db.app.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [id]);
  assert.equal((await db.app.query('SELECT id FROM siyue.subjects WHERE id=$1', [id])).rowCount, 1);
  await db.app.query('DELETE FROM siyue.subjects WHERE id=$1', [id]);
});

test('ungranted product role cannot connect to Siyue and runtime cannot connect to isolated other product', async () => {
  await db.admin.query('CREATE ROLE other_product LOGIN');
  await db.admin.query('CREATE DATABASE other_product OWNER other_product');
  await db.admin.query('REVOKE CONNECT ON DATABASE other_product FROM PUBLIC');
  await assert.rejects(db.poolFor('other_product').query('SELECT 1'), error => error.code === '42501');
  await assert.rejects(db.poolFor('siyue_app', 'other_product').query('SELECT 1'), error => error.code === '42501');
});

test('wrong database, environment or role cannot migrate; history checksum is immutable', async () => {
  await assert.rejects(migrateDatabase(db.app, db.identity), /database_identity_rejected/);
  await assert.rejects(migrateDatabase(db.migrator, {...db.identity, environment:'production'}), /database_environment_rejected/);
  await assert.rejects(migrateDatabase(db.migrator, {...db.identity, database:'other_product'}), /database_identity_rejected/);
  const directory = mkdtempSync('/tmp/siyue-migrations-');
  try {
    for(const migration of await readMigrations())writeFileSync(join(directory,migration.version),migration.sql);
    const original = readFileSync(new URL('0001_identity_core.sql', migrationDirectory), 'utf8');
    writeFileSync(join(directory,'0001_identity_core.sql'), original+'\n-- altered history\n');
    await assert.rejects(migrateDatabase(db.migrator, db.identity, pathToFileURL(directory+'/')), /migration_history_mismatch/);
  } finally { rmSync(directory, {recursive:true}); }
  await assertDatabaseReady(db.app, db.identity);
});

test('failed transaction preserves previous state', async () => {
  const id = 'c7eec393-63cb-4d25-b78a-581dfdc4e78b';
  await assert.rejects(transaction(db.app, async client => {
    await client.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')", [id]);
    throw new Error('synthetic_failure');
  }), /synthetic_failure/);
  assert.equal((await db.app.query('SELECT id FROM siyue.subjects WHERE id=$1', [id])).rowCount, 0);
});

test('runtime exposes distinct live/ready, never public Mock or unverified identity', async () => {
  const app = createRuntimeApp(db.app, db.identity);
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    assert.equal((await app.inject('/v1/ai/mock-plan')).statusCode, 404);
    assert.equal((await app.inject({url:'/v1/account/session',headers:{authorization:'Bearer invalid'}})).statusCode, 401);
    await db.admin.query("UPDATE siyue.server_metadata SET environment='staging'");
    assert.equal((await app.inject('/health/ready')).statusCode, 503);
    assert.equal((await app.inject('/health/live')).statusCode, 200);
  } finally {
    await db.admin.query("UPDATE siyue.server_metadata SET environment='test'");
    await app.close();
  }
});

test('configuration rejects admin credentials, Mock, missing fields and migration secrets without echoing values', () => {
  const good={SIYUE_ENVIRONMENT:'test',SIYUE_DATABASE_NAME:'siyue_test',SIYUE_DATABASE_URL:'postgresql://siyue_app@localhost/siyue_test'};
  assert.equal(readDatabaseConfig(good).maxConnections,5);
  for(const extra of [{SIYUE_DATABASE_URL:'postgresql://admin:private-value@localhost/siyue_test'},
    {SIYUE_MOCK_AUTH_ENABLED:'true'}, {SIYUE_MIGRATION_DATABASE_URL:'private-value'},
    {SIYUE_POSTGRES_MAX_CONNECTIONS:'100'}, {SIYUE_ENVIRONMENT:'unknown'}]) {
    assert.throws(()=>readDatabaseConfig({...good,...extra}), error=> !error.message.includes('private-value'));
  }
  assert.throws(()=>readDatabaseConfig({}), /invalid_config/);
});

test('append-only email migration upgrades existing identity data and enforces database uniqueness',async()=>{
  const legacy=await startPostgresFixture({migrate:false});const directory=mkdtempSync('/tmp/siyue-migrations-');
  const subject='c7eec393-63cb-4d25-b78a-581dfdc4e788';
  try {
    writeFileSync(join(directory,'0001_identity_core.sql'),readFileSync(new URL('0001_identity_core.sql',migrationDirectory)));
    assert.equal(await migrateDatabase(legacy.migrator,legacy.identity,pathToFileURL(directory+'/')),1);
    await legacy.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','synthetic prior subject')",[subject]);
    assert.equal(await migrateDatabase(legacy.migrator,legacy.identity),(await readMigrations()).length-1);
    assert.equal((await legacy.app.query('SELECT display_name FROM siyue.subjects WHERE id=$1',[subject])).rows[0].display_name,'synthetic prior subject');
    const insert="INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at) VALUES($1,$2,'Unique@example.test','unique@example.test',now())";
    await legacy.app.query(insert,['c7eec393-63cb-4d25-b78a-581dfdc4e789',subject]);
    await assert.rejects(legacy.app.query(insert,['c7eec393-63cb-4d25-b78a-581dfdc4e790',subject]),error=>error.code==='23505');
    await assert.rejects(legacy.app.query("UPDATE siyue.account_emails SET email_normalized='Upper@example.test'"),error=>error.code==='23514');
    await assertDatabaseReady(legacy.app,legacy.identity);
  } finally {rmSync(directory,{recursive:true});await legacy.stop();}
});
