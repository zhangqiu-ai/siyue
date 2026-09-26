import { randomBytes, randomUUID } from 'node:crypto';
import { createAuthFixture } from './auth-fixture.mjs';
import { createPasswordService } from '../../dist/modules/auth/passwords.js';
import { createEmailService } from '../../dist/modules/auth/email.js';
// 13 code points: this password is set through the registration confirmation, so it must stay in the
// 6–20 bound a password being chosen now is held to, while keeping leading/trailing spaces exact.
export const password='  练习-🌙-s-23  ';
let passwords;
// `registrationPolicy` is optional: callers that pass nothing keep the previous behaviour, while a
// caller that wants the published/closed sign-up gate passes the same policy it gives the runtime.
export async function createEmailFixture(db,{registrationPolicy}={}) {
  passwords??=await createPasswordService();
  const auth=await createAuthFixture(db);
  const email=createEmailService(db.app,auth.service,passwords,auth.cipher,randomBytes(32),auth.clock,{registrationPolicy});
  const context={ip:'192.0.2.10',requestId:randomUUID()};
  async function request(purpose='register',address=`${randomUUID()}@example.test`) {
    const response=await email.request(purpose,{email:address,locale:'zh-CN'},randomUUID(),context);
    const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[response.challengeId])).rows[0];
    const payload=job?auth.cipher.open(job.payload_ciphertext,`mail:${job.id}`):undefined;
    return {...response,code:payload?.code};
  }
  const registration=proof=>({challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,password,
    installationId:randomUUID(),platform:'ios',termsVersion:'0.0.1',privacyVersion:'0.0.1'});
  async function register(address=`${randomUUID()}@example.test`) {
    const proof=await request('register',address);
    const tokens=await email.register(registration(proof),randomUUID(),context);
    return {tokens,address,proof};
  }
  return {...auth,email,passwords,context,request,registration,register};
}
