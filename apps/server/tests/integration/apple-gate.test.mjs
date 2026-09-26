import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {createAppleRequestGate} from '../../dist/identities/apple/request-gate.js';
let db;before(async()=>{db=await startPostgresFixture();});after(async()=>{await db?.stop();});
test('shared admission budgets survive reconstruction, serialize concurrent callers and clear only expired data',async()=>{
 let now=Date.parse('2026-09-22T00:00:00Z');const pepper=randomBytes(32),make=()=>createAppleRequestGate(db.app,pepper,()=>new Date(now));
 const gate=make(),results=await Promise.all(Array.from({length:20},()=>gate.admit('start','192.0.2.1',randomUUID())));
 assert.equal(results.filter(Boolean).length,10);assert.equal(await make().admit('start','192.0.2.1',randomUUID()),false);
 const flowId=randomUUID();for(let i=0;i<30;i++)assert.equal(await gate.admit('complete',`192.0.2.${i+1}`,randomUUID(),flowId),true);
 assert.equal(await gate.admit('complete','192.0.2.99',randomUUID(),flowId),false);
 const rows=(await db.app.query('SELECT * FROM siyue.rate_limit_buckets')).rows;assert.equal(JSON.stringify(rows).includes('192.0.2.'),false);assert.equal(JSON.stringify(rows).includes(flowId),false);
 await gate.cleanup();assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.rate_limit_buckets')).rows[0].n,rows.length);
 now+=60000;await gate.cleanup();assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.rate_limit_buckets')).rows[0].n,0);
 assert.equal(await make().admit('start','192.0.2.1',randomUUID()),true);
 now+=90*86400000;await gate.cleanup();assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.security_events')).rows[0].n,0);
});
