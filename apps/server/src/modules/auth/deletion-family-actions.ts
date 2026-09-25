import type {Pool} from 'pg';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import {deletionRecipientsSchema,familyResponsibilityListSchema} from '@siyue/contracts';
import {transaction} from '../../adapters/postgres/database.js';
import {AuthError,type SessionService} from './sessions.js';
import {readFamilyManagementScope} from './family-management-acceptance.js';
import {createFrozenFamilyReviewService} from './frozen-family-review.js';

/** Only the deleting owner can see handover candidates; responsibility reads belong to the recipient. */
export function registerDeletionFamilyActions(app:FastifyInstance,pool:Pool,sessions:SessionService){
  const frozen=createFrozenFamilyReviewService(pool,sessions);
  let active=0;
  const run=(work:(request:FastifyRequest,token:string)=>Promise<unknown>)=>async(request:FastifyRequest,reply:FastifyReply)=>{
    const value=request.headers.authorization;
    const count=request.raw.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==='authorization').length;
    const fail=(code:string,status:number)=>reply.code(status).send({error:{code,messageKey:`family.errors.${code}`,retryable:status>=500||status===429},meta:{requestId:request.id}});
    if(count!==1||!value||!/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value)||request.raw.url?.includes('?')||
      (request.method==='GET'&&request.body!==undefined))return fail('FAMILY_INVALID_REQUEST',400);
    if(active>=4)return fail('FAMILY_BUSY',429);
    active++;
    try{return reply.code(request.method==='POST'?201:200).send({data:await work(request,value.slice(7)),meta:{requestId:request.id}});}
    catch(error){return error instanceof AuthError?fail(error.code,error.status):fail('FAMILY_TEMPORARILY_UNAVAILABLE',503);}
    finally{active--;}
  };
  const family=(request:FastifyRequest)=>{
    const id=z.uuid().safeParse((request.params as {familyId:unknown}).familyId);
    if(!id.success)throw new AuthError('FAMILY_INVALID_REQUEST',400);return id.data;
  };
  app.get('/v1/me/family-responsibilities',run(async(_request,token)=>transaction(pool,async client=>{
    const actor=await sessions.verifyForMutation(client,token);
    if(actor.subjectKind!=='adult')throw new AuthError('FAMILY_ADULT_REQUIRED',403);
    const rows=(await client.query<{family_id:string;status:string}>(`SELECT f.id AS family_id,f.status
      FROM siyue.families f JOIN siyue.family_memberships m ON m.family_id=f.id
      WHERE m.subject_id=$1 AND m.active AND f.owner_subject_id<>$1 AND f.status IN ('active','frozen')
      ORDER BY f.id`,[actor.subjectId])).rows;
    return familyResponsibilityListSchema.parse(rows.map(r=>({familyId:r.family_id,status:r.status})));
  })));
  app.get('/v1/families/:familyId/deletion-recipients',run(async(request,token)=>transaction(pool,async client=>{
    const actor=await sessions.verifyForMutation(client,token),id=family(request);
    if(actor.subjectKind!=='adult')throw new AuthError('FAMILY_ADULT_REQUIRED',403);
    const own=(await client.query(`SELECT f.id FROM siyue.families f JOIN siyue.family_memberships m ON m.family_id=f.id
      WHERE f.id=$1 AND f.status='active' AND f.owner_subject_id=$2 AND m.subject_id=$2 AND m.active AND m.role='owner'
      FOR UPDATE OF f,m`,[id,actor.subjectId])).rowCount;
    if(!own)throw new AuthError('FAMILY_NOT_FOUND',404);
    const rows=(await client.query<{subject_id:string;display_name:string}>(`SELECT m.subject_id,s.display_name
      FROM siyue.family_memberships m JOIN siyue.subjects s ON s.id=m.subject_id
      WHERE m.family_id=$1 AND m.active AND m.subject_id<>$2 AND s.status='active' AND s.kind='adult'
      ORDER BY m.subject_id LIMIT 201`,[id,actor.subjectId])).rows;
    if(rows.length>200)throw new AuthError('FAMILY_BUSY',429);
    const result=[];
    for(const row of rows){
      const scope=await readFamilyManagementScope(client,id,row.subject_id);
      const accepted=(await client.query(`SELECT id FROM siyue.family_management_acceptances
        WHERE family_id=$1 AND recipient_subject_id=$2 AND owner_subject_id=$3 AND family_version=$4
          AND recipient_membership_version=$5 AND owner_membership_version=$6 AND child_scope_digest=$7
          AND consumed_at IS NULL AND expires_at>now()`,[id,row.subject_id,actor.subjectId,scope.familyVersion,
          scope.membershipVersion,scope.ownerMembershipVersion,scope.childScopeDigest])).rowCount!>0;
      result.push({subjectId:row.subject_id,label:row.display_name?`${row.display_name.slice(0,80)} · ${row.subject_id.slice(0,8)}`:row.subject_id,membership:'active',
        management:accepted?'accepted':'pending',guardianship:scope.childCount===0?'none':accepted?'accepted':'pending'});
    }
    return deletionRecipientsSchema.parse(result);
  })));
  app.get('/v1/families/:familyId/frozen-review/preview',run((request,token)=>frozen.preview(token,family(request))));
  app.post('/v1/families/:familyId/frozen-review/acceptance',{bodyLimit:8192},run((request,token)=>frozen.accept(token,family(request),request.body)));
}
