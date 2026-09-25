import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from '../../adapters/postgres/database.js';
import { digest, parseOpaque, type RecoveryCipher } from '../../adapters/crypto/auth-crypto.js';
import { AuthError } from './sessions.js';

export const hour=3_600_000;
export const day=24*hour;
export type Outcome = {data:unknown;error?:never} | {error:{code:string;status:number};data?:never};
export const failure=(code:string,status=400):Outcome=>({error:{code,status}});
export function createEmailStorage(pool:Pool, cipher:RecoveryCipher, pepper:Buffer, clock:()=>Date) {
  if(pepper.length!==32) throw new Error('invalid_pepper');
  const mac=(...parts:unknown[])=>createHmac('sha256',pepper).update(JSON.stringify(parts)).digest('hex');
  async function lock(client:PoolClient,key:string) {
    // Single namespace shared by every instance; raw email/IP/password never stored in lock keys.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [BigInt.asIntN(64,BigInt(`0x${mac('lock',key).slice(0,16)}`)).toString()]);
  }
  async function count(client:PoolClient,key:string,window:number,maximum:number) {
    const now=clock();const start=new Date(Math.floor(+now/window)*window);
    const row=(await client.query(`INSERT INTO siyue.rate_limit_buckets(bucket_key_hash,window_start,count,expires_at)
      VALUES($1,$2,1,$3) ON CONFLICT(bucket_key_hash,window_start) DO UPDATE SET count=LEAST(siyue.rate_limit_buckets.count+1,1000000) RETURNING count`,
    [mac('rate',key),start,new Date(+start+window)])).rows[0];
    return row.count<=maximum;
  }
  async function audit(client:PoolClient,event:string,requestId:string,outcome:string,subjectId?:string) {
    await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,request_id,outcome,occurred_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),event,subjectId??null,requestId,outcome,clock(),new Date(+clock()+30*day)]);
  }
  return {
    mac,lock,count,audit,
    async reserveSend(client:PoolClient,budgets:Array<{key:string;window:number;maximum:number}>) {
      // Reserve all budgets or none. A rejected hour limit must not consume tomorrow's allowance.
      await lock(client,'send-budget-reservation');
      const now=clock();
      for(const budget of budgets) {
        const start=new Date(Math.floor(+now/budget.window)*budget.window);
        const row=(await client.query('SELECT count FROM siyue.rate_limit_buckets WHERE bucket_key_hash=$1 AND window_start=$2',
          [mac('rate',budget.key),start])).rows[0];
        if(row && row.count>=budget.maximum) return false;
      }
      for(const budget of budgets) await count(client,budget.key,budget.window,budget.maximum);
      return true;
    },
    equals(a:string,b:string) {const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);},
    /** All failures are values inside the transaction: counters/consumption survive rejection. */
    async idempotent<T>(scope:string,key:string,request:unknown,work:(client:PoolClient)=>Promise<Outcome>):Promise<T> {
      const keyHash=mac('idempotency-key',key); const requestMac=mac('request',scope,request);const context=`idem:${scope}:${keyHash}`;
      const outcome=await transaction(pool,async client=>{
        await lock(client,context);
        const now=clock();
        await client.query('DELETE FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2 AND expires_at<=$3',[scope,keyHash,now]);
        const previous=(await client.query('SELECT * FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2',[scope,keyHash])).rows[0];
        if(previous) {
          if(previous.request_mac!==requestMac) return failure('AUTH_IDEMPOTENCY_CONFLICT',409);
          if(!previous.response_ciphertext || +previous.response_expires_at<=+now) return failure('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED',409);
          const cached=cipher.open(previous.response_ciphertext,context) as Outcome;
          // Never restore a revoked/rotated initial credential after a reset, logout or rotation.
          const data=cached.data as {refreshToken?:string} | undefined;
          if(data?.refreshToken) {
            const token=parseOpaque(data.refreshToken);
            const row=(await client.query(`SELECT t.id FROM siyue.refresh_tokens t JOIN siyue.auth_sessions s ON s.id=t.session_id
              JOIN siyue.subjects p ON p.id=s.subject_id WHERE t.id=$1 AND t.secret_hash=$2 AND t.used_at IS NULL AND t.revoked_at IS NULL
              AND t.expires_at>$3 AND s.revoked_at IS NULL AND s.idle_expires_at>$3 AND s.absolute_expires_at>$3
              AND p.status='active' AND p.credential_version=s.credential_version`,[token.id,digest(token.secret),now])).rows[0];
            if(!row) return failure('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED',409);
          }
          return cached;
        }
        const result=await work(client);
        await client.query(`INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,status,response_ciphertext,response_expires_at,expires_at)
          VALUES($1,$2,$3,'complete',$4,$5,$6)`,[scope,keyHash,requestMac,cipher.seal(result,context),new Date(+clock()+60_000),new Date(+clock()+day)]);
        return result;
      });
      if(outcome.error) throw new AuthError(outcome.error.code,outcome.error.status);
      return outcome.data as T;
    },
    async cleanup() {
      await transaction(pool,async client=>{
        const now=clock();
        await client.query('UPDATE siyue.idempotency_records SET response_ciphertext=NULL,response_expires_at=NULL WHERE response_expires_at<=$1',[now]);
        await client.query('DELETE FROM siyue.idempotency_records WHERE expires_at<=$1',[now]);
        await client.query('DELETE FROM siyue.rate_limit_buckets WHERE expires_at<=$1',[now]);
        await client.query('DELETE FROM siyue.security_events WHERE expires_at<=$1',[now]);
        await client.query("UPDATE siyue.email_challenges SET status='expired' WHERE status='pending' AND expires_at<=$1",[now]);
        // Challenges expire after ten minutes; their address and proof hashes have no recovery
        // purpose once the associated 24-hour idempotency window has passed.
        await client.query("DELETE FROM siyue.email_challenges WHERE expires_at<=$1::timestamptz - interval '24 hours'",[now]);
      });
    },
  };
}
export type EmailStorage=ReturnType<typeof createEmailStorage>;
