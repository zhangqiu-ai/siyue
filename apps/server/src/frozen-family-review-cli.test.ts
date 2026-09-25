import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseFrozenFamilyReviewArgs,readFrozenFamilyReviewCliConfig,runFrozenFamilyReviewCli} from './frozen-family-review-cli.js';
import {isClosingSharedWorkResult} from './modules/auth/frozen-family-review.js';

const env={SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:'postgresql://siyue_review_operator@localhost/siyue_test',
 SIYUE_DATABASE_NAME:'siyue_test',SIYUE_ENVIRONMENT:'test',
 SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'siyue_review_operator, siyue_review_backup,siyue_review_operator'};
const digest='c'.repeat(64);
const resolveArgs=(reviewId:string)=>['resolve','--review',reviewId,'--recipient',randomUUID(),
 '--acceptance',randomUUID(),'--family-version','2','--recipient-membership-version','1',
 '--owner-membership-version','3','--child-scope-digest',digest,'--shared-work','separated',
 '--reason','OPS-2026-0912','--idempotency-key','review-'+randomUUID(),
 '--shared-work-checked-at','2026-09-12T03:04:05.000Z'];

test('the operator allowlist is bound to exact database login roles',()=>{
 const config=readFrozenFamilyReviewCliConfig(env);
 assert.deepEqual(config.operators,['siyue_review_operator','siyue_review_backup']);
 assert.equal(config.database,'siyue_test');
 assert.equal(config.environment,'test');
 const refused=(overrides:Record<string,string|undefined>,code:string)=>assert.throws(
   ()=>readFrozenFamilyReviewCliConfig({...env,...overrides}),{message:code});
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:undefined},'CONFIG_INVALID');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:''},'CONFIG_INVALID');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:' , '},'CONFIG_INVALID_OPERATORS');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'siyue_app'},'CONFIG_INVALID_OPERATORS');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'siyue_review_operator,siyue_app'},'CONFIG_INVALID_OPERATORS');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'Review Operator'},'CONFIG_INVALID_OPERATORS');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'S'},'CONFIG_INVALID_OPERATORS');
 // The URL's own database and shape are checked before anything connects.
 refused({SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:'postgresql://siyue_review_operator@localhost/siyue_other'},
   'CONFIG_INVALID_DATABASE_URL');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:'mysql://siyue_review_operator@localhost/siyue_test'},
   'CONFIG_INVALID_DATABASE_URL');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:'postgresql://localhost/siyue_test'},
   'CONFIG_INVALID_DATABASE_URL');
 refused({SIYUE_FROZEN_FAMILY_REVIEW_DATABASE_URL:'postgresql://siyue_review_operator@localhost/siyue_test#fragment'},
   'CONFIG_INVALID_DATABASE_URL');
 refused({SIYUE_DATABASE_NAME:'other'},'CONFIG_INVALID');
});

test('a retained shared-work result is carried but never closes a review',()=>{
 const args=resolveArgs(randomUUID());
 args[args.indexOf('--shared-work')+1]='retained_for_review';
 const parsed=parseFrozenFamilyReviewArgs(args);
 assert.ok(parsed.command==='resolve');
 if(parsed.command!=='resolve')return;
 // The command carries the observation so the kernel can refuse it with a typed code instead of a usage
 // error: shared work the operator kept for a later check means the review stays pending and the family
 // stays frozen. Only the two closing results may complete one.
 assert.equal(parsed.sharedWorkResult,'retained_for_review');
 assert.equal(isClosingSharedWorkResult(parsed.sharedWorkResult),false);
 assert.equal(isClosingSharedWorkResult('no_shared_work'),true);
 assert.equal(isClosingSharedWorkResult('separated'),true);
});

test('commands are read strictly, with every closure field required',()=>{
 assert.deepEqual(parseFrozenFamilyReviewArgs([]),{command:'help'});
 assert.deepEqual(parseFrozenFamilyReviewArgs(['help']),{command:'help'});
 assert.deepEqual(parseFrozenFamilyReviewArgs(['--help']),{command:'help'});
 assert.deepEqual(parseFrozenFamilyReviewArgs(['list']),{command:'list',limit:50});
 assert.deepEqual(parseFrozenFamilyReviewArgs(['list','--limit','5']),{command:'list',limit:5});
 const reviewId=randomUUID();
 assert.deepEqual(parseFrozenFamilyReviewArgs(['show','--review',reviewId]),{command:'show',reviewId});
 const resolve=parseFrozenFamilyReviewArgs(resolveArgs(reviewId));
 assert.equal(resolve.command,'resolve');
 if(resolve.command!=='resolve')return;
 assert.equal(resolve.sharedWorkResult,'separated');
 // The instant of the manual check is required and carried: it is part of the operation a repeated key
 // replays, so it is never defaulted to the moment of the retry.
 assert.equal(resolve.sharedWorkCheckedAt.toISOString(),'2026-09-12T03:04:05.000Z');
 assert.equal(resolve.expectedFamilyVersion,2);
 const refused=(args:string[],code:string)=>assert.throws(()=>parseFrozenFamilyReviewArgs(args),{message:code});
 refused(['freeze'],'USAGE_UNKNOWN_COMMAND');
 refused(['list','--limit'],'USAGE_MISSING_VALUE');
 refused(['list','--limit','0'],'USAGE_INVALID_LIMIT');
 refused(['list','--limit','201'],'USAGE_INVALID_LIMIT');
 refused(['list','--limit','5','--all'],'USAGE_UNKNOWN_FLAG');
 refused(['list','--limit','5','--limit','6'],'USAGE_DUPLICATE_FLAG');
 refused(['list','now'],'USAGE_UNEXPECTED_ARGUMENT');
 refused(['show'],'USAGE_MISSING_FLAG');
 refused(['show','--review','not-a-uuid'],'USAGE_INVALID_UUID');
 // An operator may not assert a recipient, a role, a child or an owner: unknown fields are not parsed
 // at all, and the required ones must be well formed.
 refused([...resolveArgs(reviewId),'--recipient-subject-id',randomUUID()],'USAGE_UNKNOWN_FLAG');
 refused(['show','--review',reviewId,'extra'],'USAGE_UNEXPECTED_ARGUMENT');
 const withoutOwner=resolveArgs(reviewId);
 withoutOwner.splice(withoutOwner.indexOf('--owner-membership-version'),2);
 refused(withoutOwner,'USAGE_MISSING_FLAG');
 const without=resolveArgs(reviewId);
 without.splice(without.indexOf('--shared-work'),2);
 refused(without,'USAGE_MISSING_FLAG');
 const withoutInstant=resolveArgs(reviewId);
 withoutInstant.splice(withoutInstant.indexOf('--shared-work-checked-at'),2);
 refused(withoutInstant,'USAGE_MISSING_FLAG');
 refused([...resolveArgs(reviewId),'--shared-work','separated'],'USAGE_DUPLICATE_FLAG');
 const badShared=resolveArgs(reviewId);badShared[badShared.indexOf('--shared-work')+1]='maybe';
 refused(badShared,'USAGE_INVALID_SHARED_WORK');
 const badDigest=resolveArgs(reviewId);badDigest[badDigest.indexOf('--child-scope-digest')+1]='c'.repeat(63);
 refused(badDigest,'USAGE_INVALID_CHILD_SCOPE_DIGEST');
 const badReason=resolveArgs(reviewId);badReason[badReason.indexOf('--reason')+1]=' spaced ';
 refused(badReason,'USAGE_INVALID_REASON');
 const badKey=resolveArgs(reviewId);badKey[badKey.indexOf('--idempotency-key')+1]='short';
 refused(badKey,'USAGE_INVALID_IDEMPOTENCY_KEY');
 const badTime=resolveArgs(reviewId);badTime[badTime.indexOf('--shared-work-checked-at')+1]='yesterday';
 refused(badTime,'USAGE_INVALID_CHECKED_AT');
 const badVersion=resolveArgs(reviewId);badVersion[badVersion.indexOf('--family-version')+1]='0';
 refused(badVersion,'USAGE_INVALID_VERSION');
});

test('a refused invocation never opens a database connection',async()=>{
 let opened=0;
 const poolFactory=()=>{opened+=1;throw new Error('must not connect');};
 const usage=await runFrozenFamilyReviewCli({argv:['list','--limit','0'],env,poolFactory});
 assert.deepEqual(usage,{exitCode:2,output:{ok:false,command:'list',code:'USAGE_INVALID_LIMIT'}});
 const config=await runFrozenFamilyReviewCli({argv:['list'],
   env:{...env,SIYUE_FROZEN_FAMILY_REVIEW_OPERATORS:'siyue_app'},poolFactory});
 assert.deepEqual(config,{exitCode:2,output:{ok:false,command:'list',code:'CONFIG_INVALID_OPERATORS'}});
 const help=await runFrozenFamilyReviewCli({argv:['help'],env,poolFactory});
 assert.deepEqual(help,{exitCode:0,output:{ok:true,command:'help'}});
 assert.equal(opened,0);
});
