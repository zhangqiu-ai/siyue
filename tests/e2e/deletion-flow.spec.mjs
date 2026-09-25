import {test,expect} from 'playwright/test';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../apps/desktop/package.json',import.meta.url));
const {createServer}=await import(require.resolve('vite'));
let server,address;
// Browser harness for the shared flow only. The controller is synthetic; this is not the product UI
// or proof that the production deletion route is enabled.
const html=`<!doctype html><html><body>
<button id="load">Load impact</button><button id="first">Choose first family</button>
<button id="second">Choose second family</button><button id="next">Continue</button>
<button id="submit">Submit deletion</button><button id="retry">Retry original request</button>
<output aria-label="Step" id="step"></output><output aria-label="Locked" id="locked"></output>
<output aria-label="Completed" id="completed"></output><output aria-label="Error" id="error"></output>
<script type="module">
import {createAccountDeletionFlow} from '/packages/adapters/src/account-deletion-flow.ts';
import {AuthClientError} from '/packages/adapters/src/auth-api-client.ts';
const ids=[crypto.randomUUID(),crypto.randomUUID()],subjectId=crypto.randomUUID();
let generation=1,status='authenticated',pending=false;const listeners=new Set();
window.calls={submit:0,retry:0,plans:[]};
const controller={deletionImpact:async()=>({subjectId,families:ids.map(familyId=>({familyId,role:'owner',soleActiveOwner:true,otherActiveAdultCount:1,otherActiveChildCount:0})),guardianships:[],activeChildDeviceCount:0}),
 submitDeletionWithPassword:async(password,plan)=>{window.calls.submit++;window.calls.plans.push(plan);pending=true;throw new AuthClientError('network');},
 submitDeletionWithApple:async()=>{throw new Error('not in fixture');},
 hasPendingDeletion:()=>pending,retryDeletion:async()=>{window.calls.retry++;pending=false;generation++;status='anonymous';for(const fn of listeners)fn();},
 deletionStatus:async()=>({deletionId:crypto.randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),status:{serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null}})};
const flow=createAccountDeletionFlow(controller,{auth:{getState:()=>({generation,status}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}}});
const render=()=>{const s=flow.getState();for(const key of ['step','locked','completed','error'])document.getElementById(key).textContent=String(s[key]??'');
 document.getElementById('first').disabled=s.locked||s.busy;document.getElementById('second').disabled=s.locked||s.busy;
 document.getElementById('retry').disabled=!s.retryPending||s.busy;};
flow.subscribe(render);render();
const action=(id,fn)=>document.getElementById(id).onclick=()=>Promise.resolve().then(fn).catch(()=>{});
action('load',()=>flow.loadImpact());action('first',()=>flow.chooseDisposition({familyId:ids[0],kind:'end-family-access'}));
action('second',()=>flow.chooseDisposition({familyId:ids[1],kind:'end-family-access'}));action('next',()=>flow.continue());
action('submit',()=>flow.submitWithPassword('long synthetic password'));action('retry',()=>flow.retry());
window.ready=true;
</script></body></html>`;
test.beforeAll(async()=>{
 server=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},logLevel:'error',
  plugins:[{name:'deletion-flow-test-harness',configureServer(vite){vite.middlewares.use('/__deletion-flow-harness',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});}}]});
 await server.listen();address=`http://127.0.0.1:${server.httpServer.address().port}`;
});
test.afterAll(async()=>{await server?.close();});
test('browser flow requires every family choice and recovers only the locked original request',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(address+'/__deletion-flow-harness');await expect.poll(async()=>({ready:await page.evaluate(()=>window.ready===true),errors}),{timeout:10000}).toEqual({ready:true,errors:[]});
 await page.getByRole('button',{name:'Load impact',exact:true}).click();await expect(page.getByLabel('Step')).toHaveText('families');
 await page.getByRole('button',{name:'Choose first family'}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(page.getByLabel('Step')).toHaveText('families');
 await page.getByRole('button',{name:'Choose second family'}).click();await page.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(page.getByLabel('Step')).toHaveText('confirm');await page.getByRole('button',{name:'Submit deletion'}).click();
 await expect(page.getByLabel('Error')).toHaveText('network');await expect(page.getByLabel('Locked')).toHaveText('true');
 await expect(page.getByRole('button',{name:'Choose first family'})).toBeDisabled();
 await page.getByRole('button',{name:'Retry original request'}).click();await expect(page.getByLabel('Step')).toHaveText('progress');
 await expect(page.getByLabel('Completed')).toHaveText('false');
 const calls=await page.evaluate(()=>window.calls);expect(calls.submit).toBe(1);expect(calls.retry).toBe(1);
 expect(calls.plans[0].families).toHaveLength(2);
});
