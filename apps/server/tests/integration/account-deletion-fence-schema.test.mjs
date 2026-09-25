import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {migrateDatabase} from '../../dist/adapters/postgres/migrate.js';
import {transaction} from '../../dist/adapters/postgres/database.js';
import {compareLedgerFence,createDeletionLedgerFenceStore}
  from '../../dist/account-deletion-ledger/fence.js';

// Additive main-database recovery fence. The fixture uses a fresh temporary cluster and never reads
// a project database URL; no real account or independent ledger is touched by this schema test.
let db;
before(async()=>{db=await startPostgresFixture();});
after(async()=>{await db?.stop();});

test('0018 creates an empty singleton fence and does not mark recovery as already proved',async()=>{
  const columns=(await db.app.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='siyue' AND table_name='deletion_ledger_fence' ORDER BY ordinal_position`))
    .rows.map(row=>row.column_name);
  assert.deepEqual(columns,['singleton','ledger_instance_id','ledger_format','applied_sequence','applied_at']);
  assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.deletion_ledger_fence')).rows[0].n,0);
  assert.equal(await migrateDatabase(db.migrator,db.identity),0);
  const id=randomUUID(),at=new Date('2026-09-24T00:00:00.000Z');
  await db.app.query(`INSERT INTO siyue.deletion_ledger_fence
    (singleton,ledger_instance_id,ledger_format,applied_sequence,applied_at)
    VALUES(true,$1,'siyue-deletion-ledger-v2',0,$2)`,[id,at]);
  assert.deepEqual((await db.app.query('SELECT ledger_instance_id,applied_sequence FROM siyue.deletion_ledger_fence')).rows[0],
    {ledger_instance_id:id,applied_sequence:'0'});
  await assert.rejects(db.app.query(`INSERT INTO siyue.deletion_ledger_fence
    (singleton,ledger_instance_id,ledger_format,applied_sequence,applied_at)
    VALUES(false,$1,'siyue-deletion-ledger-v2',1,$2)`,[randomUUID(),at]),{code:'23514'});
  await assert.rejects(db.app.query('UPDATE siyue.deletion_ledger_fence SET applied_sequence=-1'),{code:'23514'});
});

test('fence detects a restored main database, a regressed ledger and a replaced ledger',async()=>{
  await db.app.query('DELETE FROM siyue.deletion_ledger_fence');
  const store=createDeletionLedgerFenceStore(db.app);
  const point={instanceId:randomUUID(),format:'siyue-deletion-ledger-v2',sequence:3n};
  assert.equal(compareLedgerFence(await store.read(),point),'replay_required');
  await transaction(db.app,client=>store.advance(client,point));
  assert.deepEqual(await store.read(),point);
  assert.equal(compareLedgerFence(await store.read(),point),'ready');
  assert.equal(compareLedgerFence(await store.read(),{...point,sequence:4n}),'replay_required');
  assert.equal(compareLedgerFence(await store.read(),{...point,sequence:2n}),'ledger_regressed');
  assert.equal(compareLedgerFence(await store.read(),{...point,instanceId:randomUUID()}),'ledger_replaced');
  await assert.rejects(transaction(db.app,client=>store.advance(client,{...point,sequence:2n})),
    /deletion_ledger_fence_conflict/);
  await assert.rejects(transaction(db.app,client=>store.advance(client,{...point,instanceId:randomUUID()})),
    /deletion_ledger_fence_conflict/);
  await transaction(db.app,client=>store.advance(client,{...point,sequence:4n}));
  assert.equal((await store.read()).sequence,4n);
});
