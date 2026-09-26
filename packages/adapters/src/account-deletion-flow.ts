import {
  accountDeletionImpactSchema,accountPasswordSchema,deletionDependencyDispositionSchema,
  deletionFamilyDispositionSchema,deletionStatusSchema,
  type AccountDeletionImpact,type AuthClientErrorCode,type AuthClientState,
  type DeletionDependencyDisposition,type DeletionFamilyDisposition,type DeletionStatus,
} from '@siyue/contracts';
import {AuthClientError} from './auth-api-client.js';
import type {AppleAuthorize} from './apple-sign-in.js';
import type {DeletionProgress} from './auth-controller.js';

// UI-facing account-deletion flow (design 13.1/13.2, API 14.2). It owns no credential, no receipt and no
// HTTP surface: it drives an existing auth controller and publishes only the non-secret shape a settings
// screen renders. Invariants:
// 1. No defaulted decision: every affected family starts unselected, a malformed or unimpacted choice is
//    refused, and `continue` never advances while a family is unchosen.
// 2. The controller owns the submission: a failure it keeps locks the declaration that was sent, and only
//    its own `retryDeletion` may finish that request.
// 3. Completion is proven, never inferred: a progress document that claims completion must also report
//    `serverDataDeleted` and no pending provider revocation, or it is refused as `invalid_response`.
// 4. Published state is deeply frozen and carries no password, bearer, receipt or subject id.

/** The controller surface this flow drives, as a `Pick` of the real auth controller. */
export interface AccountDeletionFlowController {
  deletionImpact():Promise<AccountDeletionImpact>;
  submitDeletionWithPassword(password:string,dependencyDisposition:DeletionDependencyDisposition):Promise<void>;
  /** Apple re-verification needs a native provider flow (iOS). A controller without one — the desktop
   *  renderer client — omits this member, and `submitWithApple` refuses instead of faking it. */
  submitDeletionWithApple?(authorize:AppleAuthorize,dependencyDisposition:DeletionDependencyDisposition):Promise<void>;
  retryDeletion():Promise<void>;
  deletionStatus():Promise<DeletionProgress|null>;
  hasPendingDeletion():boolean;
}

/** The account generation this flow binds to; the real controller satisfies this structurally. */
export type AccountDeletionFlowAuth={getState():{generation:number;status:AuthClientState['status']};
  subscribe(listener:()=>void):()=>void;};

export interface AccountDeletionFlowOptions {auth:AccountDeletionFlowAuth;}

export interface AccountDeletionGuardianshipView {
  readonly childSubjectId:string;readonly soleGuardian:boolean;
  readonly otherGuardianCount:number;readonly activeChildDeviceCount:number;
}

/** One affected family. `role` is null when the subject only guards a child here, and `choice` stays null
 *  until the caller makes one. */
export interface AccountDeletionFamilyView {
  readonly familyId:string;
  readonly role:'owner'|'admin'|'member'|null;
  readonly soleActiveOwner:boolean;
  readonly otherActiveAdultCount:number;
  readonly otherActiveChildCount:number;
  readonly guardianships:readonly AccountDeletionGuardianshipView[];
  readonly choice:DeletionFamilyDisposition|null;
}

export type AccountDeletionStep='impact'|'families'|'confirm'|'submitting'|'progress';

/** The frozen, non-secret document a settings screen renders. */
export interface AccountDeletionFlowState {
  readonly step:AccountDeletionStep;
  readonly busy:boolean;
  readonly error:AuthClientErrorCode|null;
  readonly families:readonly AccountDeletionFamilyView[];
  readonly dispositionReady:boolean;
  readonly locked:boolean;
  readonly retryPending:boolean;
  readonly status:DeletionStatus|null;
  readonly completed:boolean;
}

interface MutableFamilyRow {
  familyId:string;role:'owner'|'admin'|'member'|null;soleActiveOwner:boolean;
  otherActiveAdultCount:number;otherActiveChildCount:number;
  guardianships:AccountDeletionGuardianshipView[];choice:DeletionFamilyDisposition|null;
}

const initialState=():AccountDeletionFlowState=>({step:'impact',busy:false,error:null,families:[],
  dispositionReady:false,locked:false,retryPending:false,status:null,completed:false});

/** Freezes the whole snapshot, so a caller holding a published state cannot edit a decision or inject a
 *  family into the next submission. Already frozen nodes are skipped, which keeps shared sub-arrays cheap. */
function deepFreeze<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)) {
    Object.freeze(value);
    for(const nested of Object.values(value as Record<string,unknown>))deepFreeze(nested);
  }
  return value;
}

/** A progress document may report completion only when both cleanup dimensions agree with it. A
 *  `completedAt` with open server data or a pending provider revocation is a malformed answer. */
function completionOf(status:DeletionStatus):boolean {
  const complete=status.completedAt!==null;
  if(complete&&(!status.serverDataDeleted||status.providerRevocationPending))
    throw new AuthClientError('invalid_response');
  return complete;
}

/** Builds the deletion flow around one controller and one account generation source. */
export function createAccountDeletionFlow(controller:AccountDeletionFlowController,
  options:AccountDeletionFlowOptions) {
  const listeners=new Set<()=>void>();
  let disposed=false;
  // Every local operation owns an epoch: a later operation, a reset or a dispose invalidates it, so a
  // late answer can neither publish nor overwrite state a newer step already owns.
  let epoch=0;
  let state:AccountDeletionFlowState=deepFreeze(initialState());
  let boundGeneration=options.auth.getState().generation;
  // Set only for the duration of this flow's own submission. A real accepted deletion clears the session
  // through `begin('anonymous')`, which is the single transition this flag may adopt.
  let expectOwnSettlement=false;

  const alive=(own:number)=>!disposed&&own===epoch;
  const publish=(next:AccountDeletionFlowState)=>{if(disposed)return;state=deepFreeze(next);
    for(const listener of listeners){try{listener();}catch{/* An observer cannot change this flow. */}}};
  const patch=(fields:Partial<AccountDeletionFlowState>)=>{publish({...state,...fields});};
  const safe=(error:unknown):AuthClientError=>error instanceof AuthClientError?error:new AuthClientError('unavailable');

  /** The affected family set exactly as the server compares it: the de-duplicated union of the member
   *  families and the guardianship families, in the impact's own order, with nothing chosen yet. */
  function rowsOf(impact:AccountDeletionImpact):MutableFamilyRow[] {
    const rows:MutableFamilyRow[]=[];
    const byId=new Map<string,MutableFamilyRow>();
    for(const family of impact.families) {
      const row:MutableFamilyRow={familyId:family.familyId,role:family.role,soleActiveOwner:family.soleActiveOwner,
        otherActiveAdultCount:family.otherActiveAdultCount,otherActiveChildCount:family.otherActiveChildCount,
        guardianships:[],choice:null};
      rows.push(row);byId.set(row.familyId,row);
    }
    for(const guardianship of impact.guardianships) {
      const view:AccountDeletionGuardianshipView={childSubjectId:guardianship.childSubjectId,
        soleGuardian:guardianship.soleGuardian,otherGuardianCount:guardianship.otherGuardianCount,
        activeChildDeviceCount:guardianship.activeChildDeviceCount};
      const existing=byId.get(guardianship.familyId);
      if(existing){existing.guardianships=[...existing.guardianships,view];continue;}
      const row:MutableFamilyRow={familyId:guardianship.familyId,role:null,soleActiveOwner:false,
        otherActiveAdultCount:0,otherActiveChildCount:0,guardianships:[view],choice:null};
      rows.push(row);byId.set(row.familyId,row);
    }
    return rows;
  }

  /** The caller's own declaration: `none` only when nothing is affected, never a filled-in default. */
  function disposition():DeletionDependencyDisposition {
    const families:DeletionFamilyDisposition[]=[];
    for(const row of state.families) {
      if(row.choice===null)throw new AuthClientError('invalid_request');
      families.push(row.choice);
    }
    if(families.length===0)return {kind:'none'};
    try {return deletionDependencyDispositionSchema.parse({kind:'per-family',families});}
    catch{throw new AuthClientError('invalid_request');}
  }

  /** True when the controller already owns a submission; the flow then refuses to start or edit. */
  function owedByController():boolean {
    if(!controller.hasPendingDeletion())return false;
    patch({locked:true,retryPending:true});
    return true;
  }

  function assertSubmittable():void {
    if(disposed)throw new AuthClientError('cancelled');
    if(state.busy)throw new AuthClientError('busy');
    if(state.step!=='confirm')throw new AuthClientError('invalid_request');
    if(owedByController())throw new AuthClientError('busy');
  }

  /** One receipt read under its own epoch: the parsed document, or null when this device holds no
   *  readable receipt (absent or expired). */
  async function fetchStatus(own:number):Promise<DeletionStatus|null> {
    const progress=await controller.deletionStatus();
    if(!alive(own))throw new AuthClientError('cancelled');
    if(!progress)return null;
    const parsed=deletionStatusSchema.safeParse(progress.status);
    if(!parsed.success)throw new AuthClientError('invalid_response');
    return parsed.data;
  }

  /** Refreshes `progress` from the stored receipt. Never changes `step`. */
  async function readProgress():Promise<boolean> {
    if(disposed)throw new AuthClientError('cancelled');
    if(state.step!=='progress'||state.busy)return false;
    const own=++epoch;
    patch({busy:true,error:null});
    try {
      const status=await fetchStatus(own);
      if(!alive(own))return false;
      if(!status){patch({busy:false,status:null,completed:false});return false;}
      patch({busy:false,error:null,status,completed:completionOf(status)});
      return true;
    } catch(error) {
      const failure=safe(error);
      if(!alive(own))return false;
      patch({busy:false,error:failure.code,status:null,completed:false});
      return false;
    }
  }

  /** The restart entry point. A receipt can outlive the process that accepted it, so this enters
   *  `progress` from a surviving receipt with no password and no submission. A missing or expired receipt
   *  is neither progress nor completion: the step is left alone and false is returned. */
  async function resumeProgress():Promise<boolean> {
    if(disposed)throw new AuthClientError('cancelled');
    if(state.busy||state.step==='submitting')return false;
    if(state.step==='progress')return readProgress();
    if(owedByController())return false;
    const own=++epoch;
    patch({busy:true,error:null});
    try {
      const status=await fetchStatus(own);
      if(!alive(own))return false;
      if(!status){patch({busy:false,status:null,completed:false});return false;}
      patch({step:'progress',busy:false,error:null,locked:true,retryPending:false,status,
        completed:completionOf(status)});
      return true;
    } catch(error) {
      const failure=safe(error);
      if(!alive(own))return false;
      patch({busy:false,error:failure.code,status:null,completed:false});
      return false;
    }
  }

  /** Runs one explicit submission. A failure the controller kept locks the declaration that produced it;
   *  a failure it did not keep returns to the family step so the caller can edit before retrying. */
  async function runSubmission(work:(plan:DeletionDependencyDisposition)=>Promise<void>):Promise<void> {
    assertSubmittable();
    const plan=disposition();
    const own=++epoch;
    expectOwnSettlement=true;
    patch({step:'submitting',busy:true,error:null,locked:true,retryPending:false,status:null,completed:false});
    try {await work(plan);}
    catch(error) {
      expectOwnSettlement=false;
      const failure=safe(error);
      if(!alive(own))throw new AuthClientError('cancelled');
      const owed=controller.hasPendingDeletion();
      patch(owed
        ? {step:'confirm',busy:false,error:failure.code,locked:true,retryPending:true}
        : {step:state.families.length?'families':'confirm',busy:false,error:failure.code,locked:false,
          retryPending:false,dispositionReady:state.families.length===0||state.families.every(row=>row.choice!==null)});
      throw failure;
    }
    expectOwnSettlement=false;
    if(!alive(own))throw new AuthClientError('cancelled');
    patch({step:'progress',busy:false,error:null,locked:true,retryPending:false,status:null,completed:false});
    await readProgress();
  }

  /** Clears the previous account's form; a new generation may not inherit an impact or a choice. */
  function resetForGeneration(){epoch++;expectOwnSettlement=false;publish(initialState());}

  const unsubscribe=options.auth.subscribe(()=>{
    if(disposed)return;
    const next=options.auth.getState();
    if(next.generation===boundGeneration)return;
    // Only this flow's own accepted deletion may survive a generation change, and that transition is
    // exactly one generation into `anonymous`. A sign-out, a switch, a bootstrap or any larger jump
    // clears the form instead of being mistaken for our own success.
    if(expectOwnSettlement&&next.status==='anonymous'&&next.generation===boundGeneration+1) {
      boundGeneration=next.generation;
      return;
    }
    boundGeneration=next.generation;
    resetForGeneration();
  });

  return {
    // The same frozen reference is returned until the state actually changes, so a React store sees a
    // stable snapshot between publishes.
    getState:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},

    /** Reads the strict impact and rebuilds the family list with nothing chosen. A failure keeps the
     *  `impact` step and its error; a superseded or disposed answer returns false without publishing. */
    async loadImpact():Promise<boolean> {
      if(disposed)throw new AuthClientError('cancelled');
      if(state.busy||state.step==='submitting'||state.step==='progress')return false;
      if(owedByController())throw new AuthClientError('busy');
      const own=++epoch;
      patch({step:'impact',busy:true,error:null,families:[],dispositionReady:false,locked:false,
        retryPending:false,status:null,completed:false});
      try {
        const raw=await controller.deletionImpact();
        if(!alive(own))throw new AuthClientError('cancelled');
        const parsed=accountDeletionImpactSchema.safeParse(raw);
        if(!parsed.success)throw new AuthClientError('invalid_response');
        const rows=rowsOf(parsed.data);
        patch({step:rows.length?'families':'confirm',busy:false,error:null,families:rows,
          dispositionReady:rows.length===0,locked:false,retryPending:controller.hasPendingDeletion()});
        return true;
      } catch(error) {
        const failure=safe(error);
        if(!alive(own))return false;
        if(failure.code!=='cancelled')
          patch({step:'impact',busy:false,error:failure.code,families:[],dispositionReady:false,locked:false,retryPending:false});
        throw failure;
      }
    },

    /** Records one family's own choice, replacing any earlier one for that family. The value is parsed by
     *  the strict family contract and must name an affected family. */
    chooseDisposition(input:unknown):boolean {
      if(disposed)throw new AuthClientError('cancelled');
      if(state.busy||state.locked||state.step!=='families')return false;
      const parsed=deletionFamilyDispositionSchema.safeParse(input);
      if(!parsed.success)throw new AuthClientError('invalid_request');
      const index=state.families.findIndex(row=>row.familyId===parsed.data.familyId);
      if(index<0)throw new AuthClientError('invalid_request');
      const families=state.families.map((row,at)=>at===index?{...row,choice:parsed.data}:row);
      patch({families,dispositionReady:families.every(row=>row.choice!==null),error:null});
      return true;
    },

    /** The caller's explicit confirmation that the shown per-family declaration is the one to send. */
    continue():boolean {
      if(disposed)throw new AuthClientError('cancelled');
      if(state.busy||state.locked)return false;
      if(state.step==='confirm')return true;
      if(state.step!=='families'||!state.dispositionReady)return false;
      patch({step:'confirm',error:null});
      return true;
    },

    /** Returns to the family step so the caller can change a choice, keeping the choices already made.
     *  `loadImpact` is the other way back, and it re-reads the impact instead of preserving them. */
    backToFamilies():boolean {
      if(disposed)throw new AuthClientError('cancelled');
      if(state.busy||state.locked)return false;
      if(state.step==='families')return true;
      if(state.step!=='confirm'||state.families.length===0)return false;
      patch({step:'families',error:null});
      return true;
    },

    /** One explicit password-verified submission. The password is used for this call only. */
    async submitWithPassword(password:string):Promise<void> {
      assertSubmittable();
      if(!accountPasswordSchema.safeParse(password).success)throw new AuthClientError('invalid_request');
      await runSubmission(plan=>controller.submitDeletionWithPassword(password,plan));
    },

    /** The same submission proved with Apple instead of a password. A controller built without the
     *  native Apple flow is refused before anything is read, written or submitted. */
    async submitWithApple(authorize:AppleAuthorize):Promise<void> {
      if(disposed)throw new AuthClientError('cancelled');
      const submit=controller.submitDeletionWithApple;
      if(typeof submit!=='function')throw new AuthClientError('invalid_config');
      if(typeof authorize!=='function')throw new AuthClientError('invalid_request');
      assertSubmittable();
      await runSubmission(plan=>submit.call(controller,authorize,plan));
    },

    /** Finishes the submission the controller still holds, under the declaration it already captured. */
    async retry():Promise<void> {
      if(disposed)throw new AuthClientError('cancelled');
      if(state.busy)throw new AuthClientError('busy');
      if(!controller.hasPendingDeletion()){patch({locked:false,retryPending:false});throw new AuthClientError('operation_completed');}
      const own=++epoch;
      expectOwnSettlement=true;
      patch({step:'submitting',busy:true,error:null,locked:true,retryPending:true,status:null,completed:false});
      try {await controller.retryDeletion();}
      catch(error) {
        expectOwnSettlement=false;
        const failure=safe(error);
        if(!alive(own))throw new AuthClientError('cancelled');
        const owed=controller.hasPendingDeletion();
        patch({step:'confirm',busy:false,error:failure.code,locked:owed,retryPending:owed});
        throw failure;
      }
      expectOwnSettlement=false;
      if(!alive(own))throw new AuthClientError('cancelled');
      patch({step:'progress',busy:false,error:null,locked:true,retryPending:false,status:null,completed:false});
      await readProgress();
    },

    /** Re-reads progress for the stored receipt. Valid only in the `progress` step. */
    loadProgress:readProgress,

    /** Enters `progress` from a receipt this device already holds, for a flow opened after a restart. It
     *  takes no password and never submits; it refreshes when the step is already `progress`. */
    resumeProgress,

    /** Clears the form. Allowed only before a submission exists: a submitting or progressed flow and a
     *  controller that still holds a request are both left alone. */
    cancel():boolean {
      if(disposed)return false;
      if(state.step==='submitting'||state.step==='progress')return false;
      if(owedByController())return false;
      epoch++;
      publish(initialState());
      return true;
    },

    /** Drops this flow's own state and subscription. The shared controller is deliberately not
     *  disposed: it outlives the screen, and its pending submission stays retryable. */
    dispose(){
      if(disposed)return;
      disposed=true;
      epoch++;
      expectOwnSettlement=false;
      unsubscribe();
      state=deepFreeze(initialState());
      listeners.clear();
    },
  };
}

export type AccountDeletionFlow=ReturnType<typeof createAccountDeletionFlow>;
