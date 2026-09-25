import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createAccountDeletionJobStore} from '../../apps/server/dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionImpactService} from '../../apps/server/dist/modules/auth/account-deletion-impact.js';
import {createAccountDeletionAcceptKernel} from '../../apps/server/dist/modules/auth/account-deletion-accept.js';
import {createAccountDeletionIdempotencyStore} from '../../apps/server/dist/modules/auth/account-deletion-idempotency.js';
import {createAccountDeletionSubmission} from '../../apps/server/dist/modules/auth/account-deletion-submission.js';
import {createAccountDeletionGuardedCleanupRunner} from '../../apps/server/dist/modules/auth/account-deletion-guarded-runner.js';
import {createAppleRevocationOutbox} from '../../apps/server/dist/identities/apple/revocation-outbox.js';
import {createAppleRevocationPostgresStore} from '../../apps/server/dist/identities/apple/revocation-postgres.js';
import {createDeletionLedgerStore} from '../../apps/server/dist/account-deletion-ledger/ledger-store.js';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';

let db,fx,ledger,app,url;
const headers=token=>({authorization:`Bearer ${token}`});
async function start(){
  db=await startPostgresFixture();fx=await createEmailFixture(db);
  const socket=(await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  const bin=process.env.SIYUE_TEST_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@17/bin';
  execFileSync(`${bin}/psql`,['-h',socket,'-U','siyue_test_admin','-d','postgres','-f',fileURLToPath(new URL('../../apps/server/provision/deletion-ledger.sql',import.meta.url))],{
    env:{...process.env,LC_ALL:'C',SIYUE_DELETION_LEDGER_DATABASE:'siyue_deletion_ledger',SIYUE_DELETION_LEDGER_ENVIRONMENT:'test',SIYUE_DELETION_LEDGER_APP_PASSWORD:randomBytes(32).toString('hex')},stdio:'pipe'});
  ledger=createDeletionLedgerStore(db.poolFor('siyue_deletion_ledger_app','siyue_deletion_ledger'),{database:'siyue_deletion_ledger',environment:'test'},fx.clock);
  const idem=createAccountDeletionIdempotencyStore(db.app,fx.cipher,randomBytes(32),fx.clock);
  const queue=createAppleRevocationOutbox({store:createAppleRevocationPostgresStore(db.app),cipher:fx.cipher,revoke:async()=>{throw Error('unexpected provider');},clock:fx.clock});
  const accept=createAccountDeletionAcceptKernel(db.app,fx.service,createAccountDeletionImpactService(db.app,fx.service,fx.clock),createAccountDeletionJobStore(db.app,fx.clock),queue,ledger,fx.clock,idem);
  app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,deletionSubmission:createAccountDeletionSubmission(db.app,accept,idem,ledger)});
  for(const name of ['phone-zh','phone-en','pad-zh','pad-en']){
    const proof=await fx.request('register',`deletion-${name}@example.test`);
    await fx.email.register({...fx.registration(proof),password:'siyue-native-test-password'},randomUUID(),fx.context);
  }
  url=await app.listen({host:'127.0.0.1',port:18787});
}
await start();

const cleanup=createAccountDeletionGuardedCleanupRunner(db.app,{ledger,clock:fx.clock});
let previous=Date.now(),busy=false;
const timer=setInterval(()=>{const now=Date.now();fx.advance(now-previous);previous=now;if(!busy){busy=true;void cleanup.sweep().finally(()=>{busy=false;});}},1000);
console.log('Isolated deletion QA ready on :18787');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await app.close();await db.stop();process.exit(0);});
