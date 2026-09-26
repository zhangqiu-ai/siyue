// Explicit local QA process. Never imported by the production server or client.
import {randomUUID} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
const db=await startPostgresFixture(),fx=await createEmailFixture(db);
for(const address of ['native-zh@example.test','native-en@example.test']){
 const proof=await fx.request('register',address);
 const tokens=await fx.email.register({...fx.registration(proof),password:'siyue-qa-native7'},randomUUID(),fx.context);
 await transaction(db.app,client=>client.query("UPDATE siyue.auth_sessions SET device_label='QA registration device',platform='ios' WHERE id=$1",[tokens.session.sessionId]));
}
const app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
// Test-only fault injection; never read by the production API.
let providerFailures=Number(process.env.SIYUE_QA_PROVIDER_FAILURES??0);
if(!Number.isInteger(providerFailures)||providerFailures<0||providerFailures>10){await db.stop();throw Error('Invalid QA failure count');}
app.addHook('onRequest',async(request,reply)=>{
 if(request.url==='/v1/auth/providers'&&providerFailures>0){providerFailures--;return reply.code(503).send({error:{code:'AUTH_TEMPORARILY_UNAVAILABLE'}});}
});
await app.listen({host:'127.0.0.1',port:18787});
let previous=Date.now();
const timer=setInterval(()=>{const current=Date.now();fx.advance(current-previous);previous=current;},1000);
console.log('Isolated native account fixture ready on loopback :18787; synthetic data only.');
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(timer);await app.close();await db.stop();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
