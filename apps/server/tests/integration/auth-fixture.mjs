import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';
import { createAccessSigner, RecoveryCipher } from '../../dist/adapters/crypto/auth-crypto.js';
import { createSessionService } from '../../dist/modules/auth/sessions.js';
import { transaction } from '../../dist/adapters/postgres/database.js';
export async function createAuthFixture(db) {
  const pair=await generateKeyPair('ES256',{extractable:true});
  const jwk={...await exportJWK(pair.publicKey),kid:'test-key',alg:'ES256'};
  const config={privateKey:await exportPKCS8(pair.privateKey),jwks:{keys:[jwk]},kid:'test-key',issuer:'https://siyue.test/auth',audience:'siyue-test-api'};
  const signer=await createAccessSigner(config);
  const cipher=new RecoveryCipher('test-v1',new Map([['test-v1',randomBytes(32)]]));
  let now=Date.now();
  const clock=()=>new Date(now);
  const service=createSessionService(db.app,signer,cipher,clock);
  async function issue() {
    const subjectId=randomUUID();
    return transaction(db.app,async client=>{
      await client.query("INSERT INTO siyue.subjects(id,kind) VALUES($1,'adult')",[subjectId]);
      return service.issue(client,subjectId,randomUUID(),'email');
    });
  }
  return {service,signer,cipher,pair,config,clock,issue,advance:ms=>{now+=ms;}};
}
