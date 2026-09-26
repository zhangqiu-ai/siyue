import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { emailAddressSchema } from '@siyue/contracts';
import type { RecoveryCipher } from '../crypto/auth-crypto.js';
import { transaction } from '../postgres/database.js';

const common={to:emailAddressSchema,locale:z.enum(['zh-CN','en-US'])};
export const mailPayloadSchema=z.discriminatedUnion('template',[
  z.object({...common,template:z.literal('verification'),purpose:z.enum(['register','password-reset','link-email']),code:z.string().regex(/^\d{6}$/)}).strict(),
  z.object({...common,template:z.literal('password-changed')}).strict(),
  // Losing a login method changes how the account can be reached, so the address that loses it is
  // told what happened. This is its own template on purpose: reusing the password-changed notice
  // would tell the user something that did not happen.
  z.object({...common,template:z.literal('email-unlinked')}).strict(),
]);
export type MailPayload=z.infer<typeof mailPayloadSchema>;
export type MailResult='accepted'|'retryable'|'rejected'|'uncertain';
export interface MailTransport {send(id:string,payload:MailPayload):Promise<MailResult>;close():void;}
export async function enqueueMail(client:PoolClient,cipher:RecoveryCipher,payload:MailPayload,aggregateId:string,now:Date,expires:Date) {
  mailPayloadSchema.parse(payload);const id=randomUUID();
  await client.query(`INSERT INTO siyue.outbox_jobs(id,kind,aggregate_id,payload_ciphertext,available_at,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$5)`,[id,payload.template==='verification'?'verification-email':'security-notice',aggregateId,cipher.seal(payload,`mail:${id}`),now,expires]);
}
export function createMailWorker(pool:Pool,cipher:RecoveryCipher,transport:MailTransport,clock=()=>new Date()) {
  let running=false;
  return {
    /** A lease never claims exactly-once SMTP. A crashed/ambiguous send is terminal, not blindly retried. */
    async tick() {
      if(running) return;
      running=true;
      try {
        const job=await transaction(pool,async client=>{
          const now=clock();
          await client.query(`UPDATE siyue.outbox_jobs SET status='uncertain',payload_ciphertext=NULL,completed_at=$1,last_error_code='send_interrupted'
            WHERE status='sending' AND lease_until<=$1`,[now]);
          await client.query(`UPDATE siyue.outbox_jobs SET status='expired',payload_ciphertext=NULL,completed_at=$1
            WHERE status='pending' AND expires_at<=$1`,[now]);
          const row=(await client.query(`SELECT * FROM siyue.outbox_jobs WHERE status='pending' AND available_at<=$1 AND expires_at>$1
            ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[now])).rows[0];
          if(!row) return undefined;
          const lease=randomUUID();
          await client.query(`UPDATE siyue.outbox_jobs SET status='sending',attempts=attempts+1,lease_id=$2,lease_until=$3 WHERE id=$1`,[row.id,lease,new Date(+now+60_000)]);
          return {...row,lease,attempts:row.attempts+1};
        });
        if(!job) return;
        let result:MailResult='rejected';
        let payload:MailPayload | undefined;
        try {payload=mailPayloadSchema.parse(cipher.open(job.payload_ciphertext,`mail:${job.id}`));} catch { /* corrupted payload is terminal */ }
        if(payload) {
          try {result=await transport.send(job.id,payload);} catch {result='uncertain';}
        }
        const now=clock();
        const retry=result==='retryable' && job.attempts<3 && +job.expires_at>+now+30_000;
        const state=retry?'pending':result==='accepted'?'sent':result==='uncertain'?'uncertain':'failed';
        await pool.query(`UPDATE siyue.outbox_jobs SET status=$3,available_at=$4,lease_id=NULL,lease_until=NULL,
          payload_ciphertext=CASE WHEN $3='pending' THEN payload_ciphertext ELSE NULL END,
          completed_at=CASE WHEN $3='pending' THEN NULL ELSE $5::timestamptz END,last_error_code=$6 WHERE id=$1 AND lease_id=$2 AND status='sending'`,
        [job.id,job.lease,state,new Date(+now+30_000),now,result==='accepted'?null:payload?`mail_${result}`:'payload_invalid']);
      } finally {running=false;}
    },
  };
}
