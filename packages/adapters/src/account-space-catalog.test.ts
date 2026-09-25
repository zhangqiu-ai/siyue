import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAccountSpaceCatalog} from './account-space-catalog.js';
import {openNodeConnection} from './node.js';

test('catalog creation is idempotent and environment-separated, persisted without adopting guest data',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'siyue-catalog-'));t.after(()=>rmSync(directory,{recursive:true}));
 const file=join(directory,'catalog.db'),subject=randomUUID();let catalog=createAccountSpaceCatalog(openNodeConnection(file),randomUUID);
 assert.equal(await catalog.find('test',subject),null);
 const results=await Promise.all(Array.from({length:8},()=>catalog.create('test',subject)));
 assert.ok(results.every(x=>x.namespace===results[0]!.namespace));
 const production=await catalog.create('production',subject);assert.notEqual(production.namespace,results[0]!.namespace);
 await catalog.close();catalog=createAccountSpaceCatalog(openNodeConnection(file),randomUUID);
 assert.deepEqual(await catalog.find('test',subject),results[0]);await catalog.close();
});
test('failed insertion rolls back, malformed/future records are not replaced with empty data',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'siyue-catalog-'));t.after(()=>rmSync(directory,{recursive:true}));
 const file=join(directory,'catalog.db'),first=randomUUID(),second=randomUUID();
 const connection=openNodeConnection(file);let fail=false;
 const catalog=createAccountSpaceCatalog({...connection,transaction:work=>connection.transaction(tx=>work({...tx,run:async(sql,params)=>{await tx.run(sql,params);if(fail)throw Error('disk write failure');}}))},randomUUID);
 const original=await catalog.create('test',first);fail=true;await assert.rejects(catalog.create('test',second));fail=false;
 assert.equal(await catalog.find('test',second),null);assert.deepEqual(await catalog.find('test',first),original);await catalog.close();
 const raw=new DatabaseSync(file);raw.exec("UPDATE account_spaces SET namespace='corrupt'");raw.close();
 let reopened=createAccountSpaceCatalog(openNodeConnection(file),randomUUID);
 await assert.rejects(reopened.create('test',first),{code:'corrupt_data'});await reopened.close();
 const future=new DatabaseSync(file);future.exec('PRAGMA user_version=99');future.close();
 reopened=createAccountSpaceCatalog(openNodeConnection(file),randomUUID);await assert.rejects(reopened.find('test',first),{code:'unsupported_schema'});await reopened.close();
 const preserved=new DatabaseSync(file);assert.equal((preserved.prepare('SELECT namespace FROM account_spaces WHERE subject_id=?').get(first) as {namespace:string}).namespace,'corrupt');
 assert.equal((preserved.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,99);preserved.close();
});
