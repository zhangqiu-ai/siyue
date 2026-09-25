import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { SignJWT, generateKeyPair } from 'jose';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createAuthFixture } from './auth-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { RecoveryCipher } from '../../dist/adapters/crypto/auth-crypto.js';
let db;
before(async()=>{db=await startPostgresFixture();});
after(async()=>{await db?.stop();});
const code=expected=>error=>error.code===expected;

test('strict identity, independent issuer/audience/algorithm/signature/use/time validation',async()=>{
 const f=await createAuthFixture(db); const tokens=await f.issue();
 assert.deepEqual(await f.service.verify(tokens.accessToken),tokens.session);
 const sid=tokens.session.sessionId,sub=tokens.session.subjectId;
 const base={iss:f.config.issuer,aud:f.config.audience,sub,sid,jti:randomUUID(),iat:Math.floor(+f.clock()/1000),exp:Math.floor(+f.clock()/1000)+900,cv:1,token_use:'access'};
 for(const changes of [{iss:'qiuge-api'},{aud:'qiuge-api'},{token_use:'refresh'},{iat:base.iat+60},{exp:base.iat-1},{exp:base.exp+1},{cv:2},{role:'owner'}]) {
  const token=await new SignJWT({...base,...changes}).setProtectedHeader({alg:'ES256',kid:'test-key',typ:'JWT'}).sign(f.pair.privateKey);
  await assert.rejects(f.service.verify(token));
 }
 const foreign=await generateKeyPair('ES256');
 const wrong=await new SignJWT(base).setProtectedHeader({alg:'ES256',kid:'test-key',typ:'JWT'}).sign(foreign.privateKey);
 await assert.rejects(f.service.verify(wrong));
 const hs=await new SignJWT(base).setProtectedHeader({alg:'HS256',kid:'test-key',typ:'JWT'}).sign(randomBytes(32));
 await assert.rejects(f.service.verify(hs));
 f.advance(900_000);await assert.rejects(f.service.verify(tokens.accessToken));
});

test('database revocation, blocked subject and credential version invalidate unexpired access',async()=>{
 for(const mutation of ["UPDATE siyue.subjects SET status='blocked' WHERE id=$1",'UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1']) {
  const f=await createAuthFixture(db),t=await f.issue();
  await db.app.query(mutation,[t.session.subjectId]); await assert.rejects(f.service.verify(t.accessToken));
  await assert.rejects(f.service.refresh(t.refreshToken,randomUUID()));
 }
 const f=await createAuthFixture(db),t=await f.issue();
 await f.service.logoutAccess(t.accessToken);await assert.rejects(f.service.verify(t.accessToken));
});

test('ten concurrent same-request retries produce exactly one successor and identical response',async()=>{
 const f=await createAuthFixture(db),t=await f.issue(),rotationId=randomUUID();
 const results=await Promise.all(Array.from({length:10},()=>f.service.refresh(t.refreshToken,rotationId)));
 for(const result of results) assert.deepEqual(result,results[0]);
 assert.equal((await db.app.query('SELECT count(*)::int AS n FROM siyue.refresh_tokens WHERE session_id=$1',[t.session.sessionId])).rows[0].n,2);
 const row=(await db.app.query('SELECT * FROM siyue.refresh_tokens WHERE id=$1',[t.refreshToken.split('.')[0]])).rows[0];
 assert.equal(JSON.stringify(row).includes(results[0].refreshToken),false);
 assert.equal(JSON.stringify(row).includes(results[0].accessToken),false);
 assert.equal(JSON.stringify(row).includes(rotationId),false);
 assert.equal(results[0].sessionAbsoluteExpiresAt,t.sessionAbsoluteExpiresAt);
});

test('different concurrent rotation IDs commit replay revocation for this device only',async()=>{
 const f=await createAuthFixture(db),t=await f.issue(),other=await f.issue();
 const result=await Promise.allSettled([f.service.refresh(t.refreshToken,randomUUID()),f.service.refresh(t.refreshToken,randomUUID())]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(result.find(x=>x.status==='rejected').reason.code,'AUTH_REFRESH_REPLAYED');
 await assert.rejects(f.service.verify(t.accessToken));
 assert.deepEqual(await f.service.verify(other.accessToken),other.session);
 const row=(await db.app.query('SELECT revoked_at,retry_ciphertext FROM siyue.refresh_tokens WHERE id=$1',[t.refreshToken.split('.')[0]])).rows[0];
 assert.ok(row.revoked_at);assert.equal(row.retry_ciphertext,null);
});

test('lost response recovers before deadline, cannot recover after successor consumption or deadline',async()=>{
 const f=await createAuthFixture(db),t=await f.issue(),id=randomUUID();
 const next=await f.service.refresh(t.refreshToken,id);
 f.advance(59_000);assert.deepEqual(await f.service.refresh(t.refreshToken,id),next);
 await f.service.refresh(next.refreshToken,randomUUID());
 await assert.rejects(f.service.refresh(t.refreshToken,id),code('AUTH_REFRESH_RECOVERY_EXPIRED'));
 const second=await f.issue(),id2=randomUUID();await f.service.refresh(second.refreshToken,id2);
 f.advance(60_000);await assert.rejects(f.service.refresh(second.refreshToken,id2),code('AUTH_REFRESH_RECOVERY_EXPIRED'));
 await f.service.clearExpiredRecovery();
 assert.equal((await db.app.query('SELECT retry_ciphertext FROM siyue.refresh_tokens WHERE id=$1',[second.refreshToken.split('.')[0]])).rows[0].retry_ciphertext,null);
});

test('rotation never extends absolute lifetime and rejects expired sessions',async()=>{
 const f=await createAuthFixture(db),t=await f.issue();
 f.advance(86_400_000);const next=await f.service.refresh(t.refreshToken,randomUUID());
 assert.equal(next.sessionAbsoluteExpiresAt,t.sessionAbsoluteExpiresAt);
 assert.ok(Date.parse(next.refreshExpiresAt)<=Date.parse(next.sessionAbsoluteExpiresAt));
 f.advance(31*86_400_000);await assert.rejects(f.service.refresh(next.refreshToken,randomUUID()));
});

test('expired access permits refresh-only logout; random proof cannot revoke an existing session',async()=>{
 const f=await createAuthFixture(db),t=await f.issue();
 await assert.rejects(f.service.logoutRefresh(t.refreshToken.split('.')[0]+'.'+randomBytes(32).toString('base64url')));
 assert.deepEqual(await f.service.verify(t.accessToken),t.session);
 f.advance(900_001);await f.service.logoutRefresh(t.refreshToken);await f.service.logoutRefresh(t.refreshToken);
 await assert.rejects(f.service.refresh(t.refreshToken,randomUUID()));
});

test('reauth binds action/session/version, is atomic with operation, and consumes once',async()=>{
 const f=await createAuthFixture(db),t=await f.issue(),other=await f.issue();
 const grant=await transaction(db.app,c=>f.service.issueReauth(c,t.session.sessionId,'delete-account'));
 const use=(id,action)=>transaction(db.app,c=>f.service.consumeReauth(c,id,grant.reauthGrant,action));
 await assert.rejects(use(other.session.sessionId,'delete-account'));
 await assert.rejects(use(t.session.sessionId,'change-password'));
 await assert.rejects(transaction(db.app,async c=>{await f.service.consumeReauth(c,t.session.sessionId,grant.reauthGrant,'delete-account');throw Error('operation_failed');}),/operation_failed/);
 const results=await Promise.allSettled([use(t.session.sessionId,'delete-account'),use(t.session.sessionId,'delete-account')]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 const fresh=await transaction(db.app,c=>f.service.issueReauth(c,t.session.sessionId,'change-password'));
 f.advance(300_000);await assert.rejects(transaction(db.app,c=>f.service.consumeReauth(c,t.session.sessionId,fresh.reauthGrant,'change-password')));
});

test('AEAD ciphertext rejects tampering, context mismatch and missing retired key',()=>{
 const key=randomBytes(32),cipher=new RecoveryCipher('one',new Map([['one',key]]));
 const value=cipher.seal({secret:'synthetic'},'context');
 assert.deepEqual(cipher.open(value,'context'),{secret:'synthetic'});
 assert.throws(()=>cipher.open(value,'other-context'));
 const parts=value.split('.');parts[3]=(parts[3][0]==='A'?'B':'A')+parts[3].slice(1);assert.throws(()=>cipher.open(parts.join('.'),'context'));
 assert.throws(()=>new RecoveryCipher('two',new Map([['two',randomBytes(32)]])).open(value,'context'));
 const rotated=new RecoveryCipher('two',new Map([['one',key],['two',randomBytes(32)]]));assert.deepEqual(rotated.open(value,'context'),{secret:'synthetic'});
});
