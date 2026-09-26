import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {RecoveryCipher} from '../../adapters/crypto/auth-crypto.js';

const verifiedSchema=z.object({identity:z.object({provider:z.literal('apple'),subject:z.string().min(1).max(255).regex(/^\S+$/),clientId:z.string().regex(/^[A-Za-z0-9.-]{1,255}$/)}).strict(),refreshToken:z.string().min(1).max(8192)}).strict();
type Verified=z.infer<typeof verifiedSchema>;
export class AppleIdentityStorageError extends Error {
 constructor(readonly code:'identity_unavailable'|'identity_not_linked'){super(code);}
}
/** Trusted server-only adapter: caller owns the transaction and must supply a durable
 * verified exchange result. This method does not accept HTTP identity claims.
 * All identity lifecycle mutations must lock subject before existing identity rows.
 */
export function createAppleIdentityStorage(cipher:RecoveryCipher,namespace:string,clock:()=>Date=()=>new Date()){
 z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/).parse(namespace);
 return {
  async resolve(client:PoolClient,value:Verified,displayName?:string){
   const result=verifiedSchema.parse(value);
   const name=displayName===undefined?'Siyue':z.string().trim().min(1).max(200).parse(displayName);
   // Serialize first creation across distinct authorization flows. A hash collision only
   // serializes unrelated identities; SQL uniqueness remains the authoritative boundary.
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['apple',namespace,result.identity.subject])]);
   const ref=(await client.query('SELECT id,subject_id FROM siyue.external_identities WHERE provider=$1 AND provider_namespace=$2 AND provider_subject=$3',['apple',namespace,result.identity.subject])).rows[0];
   let subjectId:string,identityId:string;const now=clock();
   if(ref){
    const subject=(await client.query('SELECT kind,status FROM siyue.subjects WHERE id=$1 FOR UPDATE',[ref.subject_id])).rows[0];
    const identity=(await client.query('SELECT subject_id,status FROM siyue.external_identities WHERE id=$1 FOR UPDATE',[ref.id])).rows[0];
    if(!subject||subject.kind!=='adult'||subject.status!=='active'||!identity||identity.status!=='active'||identity.subject_id!==ref.subject_id)throw new AppleIdentityStorageError('identity_unavailable');
    subjectId=ref.subject_id;identityId=ref.id;
    await client.query('UPDATE siyue.external_identities SET last_login_at=$2,client_id=$3 WHERE id=$1',[identityId,now,result.identity.clientId]);
   }else{
    subjectId=randomUUID();identityId=randomUUID();
    await client.query("INSERT INTO siyue.subjects(id,kind,display_name,created_at,updated_at) VALUES($1,'adult',$2,$3,$3)",[subjectId,name,now]);
    await client.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer,created_at,last_login_at)
     VALUES($1,$2,'apple',$3,$4,$5,'https://appleid.apple.com',$6,$6)`,[identityId,subjectId,namespace,result.identity.subject,result.identity.clientId,now]);
   }
   const encrypted=cipher.seal({refreshToken:result.refreshToken},`apple-identity:${identityId}:${namespace}`);
   await client.query(`INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext,updated_at) VALUES($1,$2,$3)
    ON CONFLICT(identity_id) DO UPDATE SET refresh_ciphertext=EXCLUDED.refresh_ciphertext,updated_at=EXCLUDED.updated_at`,[identityId,encrypted,now]);
   return {subjectId,identityId,created:!ref};
  },
  /** Reauth path for Apple-only accounts. The verified provider identity must already
  * exist, be active and belong to the current subject; nothing is created here. The
  * freshly exchanged provider credential only refreshes that existing link, keeping
  * Apple revocation possible without minting a second identity or session.
  */
  async requireLinked(client:PoolClient,value:Verified,subjectId:string){
   const result=verifiedSchema.parse(value),id=z.uuid().parse(subjectId),now=clock();
   const ref=(await client.query('SELECT id,subject_id FROM siyue.external_identities WHERE provider=$1 AND provider_namespace=$2 AND provider_subject=$3',['apple',namespace,result.identity.subject])).rows[0];
   if(!ref||ref.subject_id!==id)throw new AppleIdentityStorageError('identity_not_linked');
   // Same subject -> identity lock order as resolve(); no advisory first-creation lock is
   // needed because this path never creates an identity.
   const subject=(await client.query('SELECT kind,status FROM siyue.subjects WHERE id=$1 FOR UPDATE',[id])).rows[0];
   const identity=(await client.query('SELECT subject_id,status FROM siyue.external_identities WHERE id=$1 FOR UPDATE',[ref.id])).rows[0];
   if(!subject||subject.kind!=='adult'||subject.status!=='active'||!identity||identity.status!=='active'||identity.subject_id!==id)throw new AppleIdentityStorageError('identity_not_linked');
   await client.query('UPDATE siyue.external_identities SET last_login_at=$2,client_id=$3 WHERE id=$1',[ref.id,now,result.identity.clientId]);
   const encrypted=cipher.seal({refreshToken:result.refreshToken},`apple-identity:${ref.id}:${namespace}`);
   await client.query(`INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext,updated_at) VALUES($1,$2,$3)
    ON CONFLICT(identity_id) DO UPDATE SET refresh_ciphertext=EXCLUDED.refresh_ciphertext,updated_at=EXCLUDED.updated_at`,[ref.id,encrypted,now]);
   return {subjectId:id,identityId:ref.id};
  },
 };
}
