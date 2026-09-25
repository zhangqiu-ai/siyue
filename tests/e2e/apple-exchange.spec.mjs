import {test,expect} from 'playwright/test';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createAppleCodeExchange} from '../../apps/server/dist/identities/apple/exchange.js';
const require=createRequire(new URL('../../apps/server/package.json',import.meta.url));
const {generateKeyPair,exportPKCS8}=await import(require.resolve('jose'));

test('Apple exchange deadline closes the real HTTP response stream and never retries',async()=>{
 const pair=await generateKeyPair('ES256',{extractable:true});let calls=0,disconnected=false;
 let received;const seen=new Promise(resolve=>{received=resolve;});
 const server=createServer((request,response)=>{calls++;request.resume();response.on('close',()=>{disconnected=!response.writableEnded;});response.writeHead(200,{'Content-Type':'application/json'});response.write('{');received();});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=`http://127.0.0.1:${server.address().port}`;
 try{
  const exchange=await createAppleCodeExchange({teamId:'TEAM123456',keyId:'KEY1234567',clientId:'app.siyue.mobile',privateKey:await exportPKCS8(pair.privateKey)},{timeoutMs:500,
   fetcher:(url,init)=>{expect(url).toBe('https://appleid.apple.com/auth/token');return fetch(address,init);}});
  const pending=exchange({authorizationCode:'synthetic',expectedSubject:'synthetic',expectedNonceHash:'a'.repeat(64)});
  const rejected=expect(pending).rejects.toMatchObject({reason:'unknown',message:'apple_authorization_restart_required'});
  await seen;await rejected;await expect.poll(()=>disconnected).toBe(true);expect(calls).toBe(1);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
