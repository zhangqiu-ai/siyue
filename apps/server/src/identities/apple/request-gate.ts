import {createHmac,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {transaction} from '../../adapters/postgres/database.js';

/** Shared-database admission budgets; keys contain HMACs, never raw IPs or tokens. */
export function createAppleRequestGate(pool:Pool,pepper:Buffer,clock:()=>Date=()=>new Date()){
 if(pepper.length!==32)throw new Error('invalid_pepper');
 const secret=Buffer.from(pepper);
 const hash=(key:string)=>createHmac('sha256',secret).update(`apple-rate:${key}`).digest('hex');
 async function audit(client:PoolClient,operation:'start'|'complete',requestId:string,outcome:string,subjectId?:string){
  const now=clock();await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,request_id,outcome,occurred_at,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),`apple.${operation}`,subjectId??null,requestId,outcome,now,new Date(+now+90*86400000)]);
 }
 return {
  async admit(operation:'start'|'complete',ip:string,requestId:string,flowId?:string){
   return transaction(pool,async client=>{
    const now=clock(),start=new Date(Math.floor(+now/60000)*60000);let allowed=true;
    // Consistent key order across requests. Rejections consume budgets too.
    const budgets:Array<[string,number]>=[[`${operation}:global`,operation==='start'?100:300],[`${operation}:ip:${ip}`,operation==='start'?10:60]];
    if(flowId)budgets.push([`complete:flow:${flowId}`,30]);
    for(const [key,maximum] of budgets){
     const row=(await client.query(`INSERT INTO siyue.rate_limit_buckets(bucket_key_hash,window_start,count,expires_at) VALUES($1,$2,1,$3)
      ON CONFLICT(bucket_key_hash,window_start) DO UPDATE SET count=LEAST(siyue.rate_limit_buckets.count+1,1000000) RETURNING count`,[hash(key),start,new Date(+start+60000)])).rows[0];
     allowed=allowed&&row.count<=maximum;
    }
    await audit(client,operation,requestId,allowed?'attempt':'rate_limited');return allowed;
   });
  },
  async cleanup(){
   await transaction(pool,async client=>{const now=clock();await client.query('DELETE FROM siyue.rate_limit_buckets WHERE expires_at<=$1',[now]);await client.query('DELETE FROM siyue.security_events WHERE expires_at<=$1',[now]);});
  },
  async failed(operation:'start'|'complete',requestId:string,outcome:'invalid_request'|'invalid_flow'|'invalid_identity'|'exchange_failed'|'identity_unavailable'|'unavailable'){
   await transaction(pool,client=>audit(client,operation,requestId,outcome));
  },
  async completed(client:PoolClient,subjectId:string,requestId:string){await audit(client,'complete',requestId,'success',subjectId);},
 };
}
export type AppleRequestGate=ReturnType<typeof createAppleRequestGate>;
