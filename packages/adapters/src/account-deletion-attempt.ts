import {accountDeletionRequestSchema,deletionReceiptSchema,
  type AccountDeletionRequest,type AuthClientErrorCode,type DeletionReceipt} from '@siyue/contracts';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';

/** Repeatable only when the request never reached the server or left its outcome open, so repeating
 * the caller's key recovers the job that key already created. Every other answer, including the
 * server's own `busy`, `rate_limited` and `reauth_required`, is about this submission, and replaying
 * a spent `delete-account` grant would not repair it, so those end the attempt. */
const retryable=new Set<AuthClientErrorCode>(['network','timeout','unavailable','deletion_outcome_unknown','invalid_response']);
/** The caller's own key: never minted or rotated here, and reused verbatim by every repeat, because a
 * fresh key cannot read back the job an earlier one made. */
const callerKey=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface AccountDeletionAttemptOptions {
  /** The submission route alone: no grant is requested here and no retry happens on its own. */
  api:Pick<AuthApiClient,'submitDeletion'>;
  accessToken:string;
  input:AccountDeletionRequest;
  key:string;
}

/** One caller-driven account-deletion submission: the caller decides when it runs, whether a failed
 * run is repeated and when the attempt is abandoned. The bearer and the single-use grant stay in this
 * closure, so neither reaches the returned surface, a persisted state record or a log. */
export interface AccountDeletionAttempt {
  run:(signal?:AbortSignal)=>Promise<DeletionReceipt>;
  clear:()=>void;
  canRetry:()=>boolean;
}

/** `run` dispatches one request per caller-driven attempt under the caller's bearer and key. A repeat
 * after a transport failure resends that same bearer, body and key — never re-verifying the caller and
 * never asking for another grant — while the receipt of an accepted submission is cached so a failed
 * secure write can read it back without a second destructive send. */
export function createAccountDeletionAttempt({api,accessToken,input,key}:AccountDeletionAttemptOptions):AccountDeletionAttempt {
  // The strict contract both validates and snapshots the body: its parsed result owns every nested
  // value, and it refuses an extra field even when that field's value is `undefined`.
  let body:AccountDeletionRequest;
  try{body=accountDeletionRequestSchema.parse(input);}catch{throw new AuthClientError('invalid_request');}
  if(typeof accessToken!=='string'||accessToken.trim().length===0)throw new AuthClientError('invalid_request');
  if(!callerKey.test(key))throw new AuthClientError('invalid_request');
  // The whole credential surface of the attempt: the bearer and the body holding the single-use grant.
  let bearer:string|undefined=accessToken;
  let payload:AccountDeletionRequest|undefined=body;
  let receipt:DeletionReceipt|undefined;
  let staged=false;
  let ended=false;
  let active=false;
  // A clear() has to beat the answer of a request it landed on, so each dispatch is fenced by its generation.
  let epoch=0;
  const end=()=>{epoch++;receipt=undefined;bearer=undefined;payload=undefined;staged=false;ended=true;};
  const validated=(value:unknown):DeletionReceipt=>{try{return deletionReceiptSchema.parse(value);}catch{throw new AuthClientError('invalid_response');}};
  return {
    // True while a repeat `run` still does something: a staged transport failure repeats the same keyed
    // body, and a cached receipt is handed back for the caller's secure-storage recovery.
    canRetry:()=>!ended&&(!!receipt||staged),
    // Drops the cached receipt, the bearer and the staged grant; a request already in flight is fenced
    // off rather than cancelled, so its answer cannot become a receipt.
    clear:()=>end(),
    async run(signal?:AbortSignal):Promise<DeletionReceipt> {
      if(receipt)return {...receipt};
      if(ended||!bearer||!payload)throw new AuthClientError('cancelled');
      if(active)throw new AuthClientError('busy');
      if(signal?.aborted)throw new AuthClientError('cancelled');
      active=true;
      const own=epoch,token=bearer,sent=payload;
      staged=false;
      try{
        const answer=await api.submitDeletion(token,sent,key,signal);
        if(own!==epoch)throw new AuthClientError('cancelled');
        const proof=validated(answer);
        receipt=proof;
        // The submission is committed and its receipt is cached; bearer and spent grant have no use left.
        bearer=undefined;payload=undefined;
        return {...proof};
      }catch(error){
        // A foreign throw becomes an outage with its message discarded, so an error that carries a token
        // cannot travel past this closure.
        const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
        if(own!==epoch)throw new AuthClientError('cancelled');
        if(retryable.has(safe.code))staged=true;else end();
        throw safe;
      }finally{active=false;}
    },
  };
}
