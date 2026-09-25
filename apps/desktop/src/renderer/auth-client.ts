import {deletionRecipientsSchema,familyResponsibilityListSchema,frozenFamilyReviewScopeSchema,frozenFamilyReviewAcceptanceReceiptSchema} from '@siyue/contracts';
import { authClientStateSchema,authClientErrorCodeSchema,authProvidersSchema,emailChallengeResponseSchema,accountDeviceSessionsPageSchema,accountLoginMethodsSchema,authHostRequestSchema,
  registrationPolicySchema,
  familyManagementAcceptancePreviewSchema,familyManagementAcceptanceReceiptSchema,type FamilyManagementAcceptanceRequest,accountDeletionImpactSchema,accountDeletionProgressSchema,type DeletionDependencyDisposition,
  type AuthClientState,type AuthHostRequest,type EmailChallengeRequest,type EmailRegisterConfirm,type EmailPasswordResetConfirm } from '@siyue/contracts';
import { AuthClientError } from '@siyue/adapters';

type Bridge={auth:(request:AuthHostRequest)=>Promise<unknown>;onAuthState:(callback:(value:unknown)=>void)=>()=>void};
export function createRendererAuth(bridge:Bridge|undefined) {
  let state:AuthClientState={status:'bootstrapping',generation:0,session:null,account:null,error:null,pendingRevocations:0};
  const listeners=new Set<()=>void>();let events=0;
  function receive(value:unknown) {
    const parsed=authClientStateSchema.safeParse(value);
    if(parsed.success&&parsed.data.generation>=state.generation){state=parsed.data;for(const fn of listeners)fn();}
  }
  bridge?.onAuthState(value=>{events++;receive(value);});
  async function command(operation:AuthHostRequest['operation'],payload:unknown={}) {
    if(!bridge)throw new AuthClientError('unavailable');
    const request=authHostRequestSchema.safeParse({version:1,requestId:crypto.randomUUID(),generation:state.generation,operation,payload});
    if(!request.success)throw new AuthClientError('invalid_request');
    const raw=await bridge.auth(request.data);
    if(!raw||typeof raw!=='object'||!('version' in raw)||raw.version!==1||!('requestId' in raw)||raw.requestId!==request.data.requestId||!('ok' in raw))throw new AuthClientError('invalid_response');
    if(raw.ok===false) {
      const error=authClientErrorCodeSchema.safeParse('error' in raw?raw.error:null);
      const retry='retryAfterSeconds' in raw&&typeof raw.retryAfterSeconds==='number'?Math.min(3600,Math.max(0,raw.retryAfterSeconds)):0;
      throw new AuthClientError(error.success?error.data:'unavailable',retry);
    }
    if(raw.ok!==true||!('data' in raw)||!('generation' in raw)||typeof raw.generation!=='number')throw new AuthClientError('invalid_response');
    if(raw.generation<state.generation)throw new AuthClientError('cancelled');
    return raw.data;
  }
  async function stateCommand(operation:'state'|'restore'|'login',payload:unknown={}) {
    const before=events;
    const raw=await command(operation,payload),parsed=authClientStateSchema.safeParse(raw);
    if(!parsed.success)throw new AuthClientError('invalid_response');
    if(events===before||parsed.data.generation>state.generation)receive(parsed.data);
  }
  return {
    getState:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
    initialize:()=>stateCommand('state'),bootstrap:()=>stateCommand('restore'),
    login:(input:{email:string;password:string})=>stateCommand('login',input),
    async providers(){const parsed=authProvidersSchema.safeParse(await command('providers'));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    // Registration reads the released terms/privacy versions and hands them back on confirmation. The
    // renderer never invents a version: the strict confirmation payload carries the platform the host
    // bound, and the main process binds `desktop` again before the controller sees it.
    async registrationPolicy(){const parsed=registrationPolicySchema.safeParse(await command('registration-policy'));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async requestRegistration(input:EmailChallengeRequest,key:string){const parsed=emailChallengeResponseSchema.safeParse(await command('request-registration',{input,key}));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async register(input:Omit<EmailRegisterConfirm,'installationId'>,key:string){const {platform,...confirmation}=input;
      if(platform!=='desktop')throw new AuthClientError('invalid_request');
      const parsed=authClientStateSchema.safeParse(await command('register',{input:confirmation,key}));if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    async requestReset(input:EmailChallengeRequest,key:string){const parsed=emailChallengeResponseSchema.safeParse(await command('request-reset',{input,key}));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async confirmReset(input:EmailPasswordResetConfirm,key:string){if(await command('confirm-reset',{input,key})!==null)throw new AuthClientError('invalid_response');},
    async changePassword(currentPassword:string,newPassword:string,key:string){const raw=await command('change-password',{currentPassword,newPassword,key});const parsed=authClientStateSchema.safeParse(raw);if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    async retryPasswordChange(){const raw=await command('retry-password-change');const parsed=authClientStateSchema.safeParse(raw);if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    hasPendingPasswordChange:()=>state.passwordChangePending===true,
    async deviceSessions(cursor?:string){const parsed=accountDeviceSessionsPageSchema.safeParse(await command('device-sessions',cursor?{cursor}:{}));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async loginMethods(){const parsed=accountLoginMethodsSchema.safeParse(await command('login-methods'));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async unlinkIdentity(identityId:string,currentPassword:string){const raw=await command('unlink-identity',{identityId,currentPassword});const parsed=authClientStateSchema.safeParse(raw);if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    async revokeDeviceSession(sessionId:string,currentPassword?:string){const raw=await command('revoke-device-session',{sessionId,...(currentPassword===undefined?{}:{currentPassword})});const parsed=authClientStateSchema.safeParse(raw);if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    async revokeAllDeviceSessions(currentPassword:string){const raw=await command('revoke-all-device-sessions',{currentPassword});const parsed=authClientStateSchema.safeParse(raw);if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    deletionRecipients:(familyId:string)=>command('deletion-recipients',{familyId}).then(value=>deletionRecipientsSchema.parse(value)),
    familyResponsibilities:()=>command('family-responsibilities').then(value=>familyResponsibilityListSchema.parse(value)),
    frozenFamilyPreview:(familyId:string)=>command('frozen-family-preview',{familyId}).then(value=>frozenFamilyReviewScopeSchema.parse(value)),
    acceptFrozenFamily:(familyId:string,input:FamilyManagementAcceptanceRequest)=>command('accept-frozen-family',{familyId,input}).then(value=>frozenFamilyReviewAcceptanceReceiptSchema.parse(value)),
    async familyManagementPreview(familyId:string){const parsed=familyManagementAcceptancePreviewSchema.safeParse(await command('family-management-preview',{familyId}));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async acceptFamilyManagement(familyId:string,input:FamilyManagementAcceptanceRequest){const parsed=familyManagementAcceptanceReceiptSchema.safeParse(await command('accept-family-management',{familyId,input}));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    hasPendingDeletion:()=>state.deletionPending===true,
    async deletionImpact(){const parsed=accountDeletionImpactSchema.safeParse(await command('deletion-impact'));if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async deletionStatus(){const raw=await command('deletion-status');if(raw===null)return null;const parsed=accountDeletionProgressSchema.safeParse(raw);if(!parsed.success)throw new AuthClientError('invalid_response');return parsed.data;},
    async submitDeletionWithPassword(currentPassword:string,dependencyDisposition:DeletionDependencyDisposition){const parsed=authClientStateSchema.safeParse(await command('submit-deletion',{currentPassword,dependencyDisposition}));if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    async retryDeletion(){const parsed=authClientStateSchema.safeParse(await command('retry-deletion'));if(!parsed.success)throw new AuthClientError('invalid_response');receive(parsed.data);},
    async logout(){const raw=await command('logout');if(!raw||typeof raw!=='object'||!('local' in raw)||raw.local!==true||!('server' in raw)||!['pending','confirmed'].includes(String(raw.server)))throw new AuthClientError('invalid_response');return {local:true,server:raw.server as 'pending'|'confirmed'};},
  };
}
let singleton:ReturnType<typeof createRendererAuth>|undefined;
export function rendererAuth(){return singleton??=createRendererAuth((window as unknown as {siyueDesktop?:Bridge}).siyueDesktop);}
