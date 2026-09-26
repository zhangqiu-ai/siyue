import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { execFileSync,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { renderMail,smtpConfigSchema } from '../../dist/adapters/mail/smtp.js';
const run=promisify(execFile);
let directory,server,port,mode='accepted',messages=[];
before(async()=>{
 directory=mkdtempSync('/tmp/siyue-smtp-');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 server=createServer({key:readFileSync(join(directory,'key.pem')),cert:readFileSync(join(directory,'cert.pem'))},socket=>{
  socket.setEncoding('utf8');socket.write('220 localhost synthetic-test\r\n');let buffer='',data=false,body=[];
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
   buffer+=chunk;
   while(buffer.includes('\r\n')) {
    const end=buffer.indexOf('\r\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(data) {
     if(line!=='.') {body.push(line);continue;}
     messages.push(body.join('\n'));body=[];data=false;
     if(mode==='uncertain') {socket.destroy();return;}
     socket.write(mode==='rejected'?'550 synthetic reject\r\n':'250 synthetic accepted\r\n');continue;
    }
    if(line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
    else if(line.startsWith('AUTH')) socket.write('235 authenticated\r\n');
    else if(line.startsWith('MAIL FROM')||line.startsWith('RCPT TO')) socket.write('250 OK\r\n');
    else if(line==='DATA') {data=true;socket.write('354 send body\r\n');}
    else if(line==='QUIT') socket.end('221 bye\r\n');
   }
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));rmSync(directory,{recursive:true,force:true});});
async function send(trust=true) {
 const script=`import {createSmtpTransport} from './dist/adapters/mail/smtp.js';
 const transport=createSmtpTransport(JSON.parse(process.argv[1]));
 try {console.log(await transport.send('synthetic-job',{template:'verification',to:'synthetic@example.test',locale:'en-US',purpose:'register',code:'000012'}));} finally {transport.close();}`;
 const config={host:'127.0.0.1',port,secure:true,user:'synthetic',password:'synthetic',from:'siyue@example.test'};
 const result=await run(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{cwd:new URL('../..',import.meta.url),
   env:{PATH:process.env.PATH,...(trust?{NODE_EXTRA_CA_CERTS:join(directory,'cert.pem')}:{})},timeout:10_000,maxBuffer:4096});
 return result.stdout.trim();
}
test('SMTP adapter submits fixed template through verified local TLS, preserving leading zero OTP',async()=>{
 mode='accepted';assert.equal(await send(),'accepted');
 assert.equal(messages.length,1);assert.match(messages[0],/000012/);assert.match(messages[0],/Message-ID: <siyue-synthetic-job@example.test>/i);
 assert.equal(smtpConfigSchema.safeParse({host:'smtp.invalid',port:587,user:'x',password:'x',from:'x@example.test',tls:{rejectUnauthorized:false}}).success,false);
});
test('SMTP distinguishes explicit refusal from lost final acknowledgement, and refuses untrusted TLS',async()=>{
 mode='rejected';assert.equal(await send(),'rejected');mode='uncertain';assert.equal(await send(),'uncertain');
 const before=messages.length;assert.notEqual(await send(false),'accepted');assert.equal(messages.length,before);
});
test('templates support Chinese/English and never accept user HTML, links or attachment paths',()=>{
  for(const locale of ['zh-CN','en-US']) {
   const rendered=renderMail({template:'password-changed',locale,to:'synthetic@example.test'});
   assert.ok(rendered.subject);assert.ok(rendered.text);assert.equal('html' in rendered,false);
  }
});
// The notice for a removed login method is its own template: it must not reuse the
// password-changed wording, and it must not echo the address or offer a link the mail cannot own.
test('the unlink notice is rendered in both languages without HTML, links or a copied password notice',()=>{
 for(const locale of ['zh-CN','en-US']) {
  const rendered=renderMail({template:'email-unlinked',locale,to:'synthetic@example.test'});
  assert.equal('html' in rendered,false);
  assert.match(rendered.subject,/Siyue|思玥/);
  assert.doesNotMatch(rendered.text,/只能用.*Apple|only sign in with.*Apple/i);
  assert.match(rendered.text,locale==='zh-CN'?/其余已绑定的登录方式/:/other linked sign-in methods/);
  assert.match(rendered.text,locale==='zh-CN'?/登录/:/sign-in/);
  assert.equal(/https?:\/\//.test(rendered.text),false);
  assert.equal(rendered.text.includes('synthetic@example.test'),false);
 }
 assert.notDeepEqual(renderMail({template:'email-unlinked',locale:'zh-CN',to:'synthetic@example.test'}),
  renderMail({template:'password-changed',locale:'zh-CN',to:'synthetic@example.test'}));
});
