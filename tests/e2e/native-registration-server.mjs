// Explicit local QA fixture. Never imported by the production server or client.
//
// This process never creates an account: the real mobile screen performs the register request and the
// confirm. The only QA-only addition is a read of the pending verification code, reachable from the
// machine's own loopback, so the UI test can type the code the server actually issued. Accounts are
// created and then deleted by the screen; the fixture keeps the deletion ledger so that same run can
// finish the deletion it started.
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createAccountDeletionAcceptKernel} from '../../apps/server/dist/modules/auth/account-deletion-accept.js';
import {createAccountDeletionIdempotencyStore} from '../../apps/server/dist/modules/auth/account-deletion-idempotency.js';
import {createAccountDeletionImpactService} from '../../apps/server/dist/modules/auth/account-deletion-impact.js';
import {createAccountDeletionJobStore} from '../../apps/server/dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionSubmission} from '../../apps/server/dist/modules/auth/account-deletion-submission.js';
import {createAccountDeletionGuardedCleanupRunner} from '../../apps/server/dist/modules/auth/account-deletion-guarded-runner.js';
import {createAppleRevocationOutbox} from '../../apps/server/dist/identities/apple/revocation-outbox.js';
import {createAppleRevocationPostgresStore} from '../../apps/server/dist/identities/apple/revocation-postgres.js';
import {createDeletionLedgerStore} from '../../apps/server/dist/account-deletion-ledger/ledger-store.js';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';

// A published test policy: the mobile registration step refuses to send a code without released
// versions, so this is the state the screen must see. Nothing here relaxes the product gate.
const published={enabled:true,
 terms:{version:'2026-09-25-terms-test',url:'https://example.test/siyue/terms'},
 privacy:{version:'2026-09-25-privacy-test',url:'https://example.test/siyue/privacy'}};
const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'];
const normalise=value=>String(value??'').trim().toLowerCase();
// The isolated QA app is built against :18787. The override exists only so this fixture can be smoke
// tested next to another running fixture; a real native run uses the default.
const port=process.env.SIYUE_QA_PORT===undefined?18787:Number(process.env.SIYUE_QA_PORT);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid QA port');

const db=await startPostgresFixture();
const fx=await createEmailFixture(db,{registrationPolicy:published});
const socket=(await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
const bin=process.env.SIYUE_TEST_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@17/bin';
execFileSync(`${bin}/psql`,['-h',socket,'-U','siyue_test_admin','-d','postgres','-f',fileURLToPath(new URL('../../apps/server/provision/deletion-ledger.sql',import.meta.url))],{
  env:{...process.env,LC_ALL:'C',SIYUE_DELETION_LEDGER_DATABASE:'siyue_deletion_ledger',SIYUE_DELETION_LEDGER_ENVIRONMENT:'test',SIYUE_DELETION_LEDGER_APP_PASSWORD:randomBytes(32).toString('hex')},stdio:'pipe'});
const ledger=createDeletionLedgerStore(db.poolFor('siyue_deletion_ledger_app','siyue_deletion_ledger'),{database:'siyue_deletion_ledger',environment:'test'},fx.clock);
const idem=createAccountDeletionIdempotencyStore(db.app,fx.cipher,randomBytes(32),fx.clock);
const queue=createAppleRevocationOutbox({store:createAppleRevocationPostgresStore(db.app),cipher:fx.cipher,revoke:async()=>{throw Error('unexpected provider');},clock:fx.clock});
const accept=createAccountDeletionAcceptKernel(db.app,fx.service,createAccountDeletionImpactService(db.app,fx.service,fx.clock),createAccountDeletionJobStore(db.app,fx.clock),queue,ledger,fx.clock,idem);
const app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,registrationPolicy:published,
  deletionSubmission:createAccountDeletionSubmission(db.app,accept,idem,ledger)});

// The socket decides who may read QA state. A forwarded header cannot move that decision, and the
// listener below only accepts loopback connections in the first place.
app.addHook('onRequest',async(request,reply)=>{
 if(request.raw.url?.startsWith('/qa/')&&!loopback.includes(request.ip))return reply.code(404).send({error:'not_found'});
});
// The pending code, never the sealed payload, and never a log line.
app.get('/qa/mail/code',async(request,reply)=>{
 const email=normalise(request.query?.email);
 if(!email)return reply.code(400).send({error:'email_required'});
 const row=(await db.app.query(`SELECT j.id,j.payload_ciphertext FROM siyue.outbox_jobs j
  JOIN siyue.email_challenges c ON c.id=j.aggregate_id
  WHERE c.email_normalized=$1 AND c.purpose='register' AND c.status='pending' AND j.payload_ciphertext IS NOT NULL
  ORDER BY j.created_at DESC LIMIT 1`,[email])).rows[0];
 if(!row)return reply.code(404).send({error:'no_pending_code'});
 return {code:fx.cipher.open(row.payload_ciphertext,`mail:${row.id}`).code};
});
// Read-only account probe: it lets the UI test show that the screen, not this fixture, created the
// account, without granting any route that could create one.
app.get('/qa/account',async(request,reply)=>{
 const email=normalise(request.query?.email);
 if(!email)return reply.code(400).send({error:'email_required'});
 return {exists:(await db.app.query('SELECT subject_id FROM siyue.account_emails WHERE email_normalized=$1',[email])).rowCount===1};
});

await app.listen({host:'127.0.0.1',port});

const cleanup=createAccountDeletionGuardedCleanupRunner(db.app,{ledger,clock:fx.clock});
let previous=Date.now(),busy=false;
const timer=setInterval(()=>{const now=Date.now();fx.advance(now-previous);previous=now;if(!busy){busy=true;void cleanup.sweep().finally(()=>{busy=false;});}},1000);
console.log(`Isolated registration QA fixture ready on loopback :${port}; the screen creates every account.`);
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(timer);await app.close();await db.stop();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,close);
