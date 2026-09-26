import {disabledRegistrationPolicy,type RegistrationPolicy} from './registration-policy.js';
import {registerDeletionFamilyActions} from './modules/auth/deletion-family-actions.js';
import type {createAccountDeletionSubmission} from './modules/auth/account-deletion-submission.js';
import {isIP} from 'node:net';
import {registerAppleRoutes,type AppleRoutes} from './identities/apple/routes.js';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { assertDatabaseReady } from './adapters/postgres/migrate.js';
import type { DatabaseIdentity } from './adapters/postgres/database.js';
import { registerSessionRoute, type SessionOptions } from './session.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { AuthError, type SessionService } from './modules/auth/sessions.js';
import type { EmailService } from './modules/auth/email.js';
import { registerEmailRoutes } from './modules/auth/email-routes.js';
import { registerIdentityRoutes } from './modules/auth/identities-routes.js';
import { createIdentitySummary } from './modules/auth/identities.js';
import { registerIdentityUnlinkRoutes } from './modules/auth/identity-unlink-routes.js';
import { createIdentityUnlinkService } from './modules/auth/identity-unlink.js';
import { createFamilyRepository } from './modules/families/repository.js';
import { registerFamilyRoutes } from './modules/families/routes.js';
import { registerFamilyInvitationRoutes } from './modules/families/invitation-routes.js';
import type { FamilyInvitationService } from './modules/families/invitations.js';
import { registerGuardianRoutes } from './modules/families/guardian-routes.js';
import type { GuardianshipService } from './modules/families/guardianship.js';
import { registerChildDeviceRoutes } from './modules/families/child-device-routes.js';
import type { ChildDeviceService } from './modules/families/child-devices.js';
import { registerChildDevicePairingRoutes } from './modules/families/device-pairing-routes.js';
import type { ChildDevicePairingService } from './modules/families/device-pairings.js';
import { createAccountDeletionImpactService } from './modules/auth/account-deletion-impact.js';
import { createAccountDeletionJobStore } from './modules/auth/account-deletion-jobs.js';
import { registerAccountDeletionReadRoutes } from './modules/auth/account-deletion-routes.js';
import { createFamilyManagementAcceptanceService } from './modules/auth/family-management-acceptance.js';
import { registerFamilyManagementAcceptanceRoutes } from './modules/auth/family-management-acceptance-routes.js';

/** Database-backed runtime. No public development Mock endpoints. */
export function createRuntimeApp(pool: Pool, identity: DatabaseIdentity, options: SessionOptions & {sessions?: SessionService; email?: EmailService; apple?:AppleRoutes;familyInvitations?:FamilyInvitationService;guardianship?:GuardianshipService;childDevices?:ChildDeviceService;devicePairings?:ChildDevicePairingService;trustedProxyCidrs?:string[];registrationPolicy?:RegistrationPolicy;deletionReady?:()=>Promise<boolean>;deletionSubmission?:ReturnType<typeof createAccountDeletionSubmission>} = {}) {
  const app = Fastify({trustProxy:options.trustedProxyCidrs?.length?options.trustedProxyCidrs:false,logger: false, bodyLimit: 16_384,
    ajv: {customOptions: {coerceTypes: false, removeAdditional: false}}});
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Native HTTP has no Origin. Preserve the existing deny-by-default policy.
    if (request.headers.origin) return reply.code(403).send({error: 'origin_denied'});
    if(!isIP(request.ip))return reply.code(400).send({error:{code:'AUTH_INVALID_REQUEST',messageKey:'auth.errors.AUTH_INVALID_REQUEST',retryable:false},meta:{requestId:request.id}});
    // A restored main database can drift from the deletion ledger while this process is running.
    // Readiness alone is advisory; hold every external API path until the recovery invariant holds.
    if(request.url.startsWith('/v1/')&&options.deletionReady){
      let ready=false;
      try{ready=await options.deletionReady();}catch{/* unreadable recovery state stays closed */}
      if(!ready)return reply.code(503).send({error:'temporarily_unavailable'});
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (request.url.startsWith('/v1/auth/') || request.url.startsWith('/v1/me/')) {
      const code=status===413?'AUTH_BODY_TOO_LARGE':status<500?'AUTH_INVALID_REQUEST':'AUTH_TEMPORARILY_UNAVAILABLE';
      return reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status>=500},meta:{requestId:request.id}});
    }
    return reply.code(status).send({error: status === 413 ? 'body_too_large' : status < 500 ? 'invalid_request' : 'internal_error'});
  });
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:'not_found'}));
  app.get('/health/live', async () => ({ok: true}));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await assertDatabaseReady(pool, identity);
      if(options.deletionReady&&!await options.deletionReady())throw new Error('deletion_recovery_unready');
      return {ok: true};
    }
    catch { return reply.code(503).send({ok: false}); }
  });
  app.get('/v1/auth/registration-policy',async(request,reply)=>{
    if(request.headers.authorization!==undefined||request.raw.url?.includes('?')||request.body!==undefined)
      return reply.code(400).send({error:{code:'AUTH_INVALID_REQUEST',messageKey:'auth.errors.AUTH_INVALID_REQUEST',retryable:false},meta:{requestId:request.id}});
    return {data:options.email?(options.registrationPolicy??disabledRegistrationPolicy):disabledRegistrationPolicy,meta:{requestId:request.id}};
  });
  registerSessionRoute(app, options.sessions ? {...options, sessionVerifier:(token,signal)=>options.sessions!.verify(token,signal),
    sessionErrorStatus:error=>error instanceof AuthError?(error.status===503?503:401):503} : options);
  if (options.sessions) {
    registerAuthRoutes(app,options.sessions,!!options.email,!!options.apple);
    registerAccountDeletionReadRoutes(app,createAccountDeletionImpactService(pool,options.sessions),createAccountDeletionJobStore(pool),options.deletionSubmission);
    // Read-only login-method summary: no migration, no write path and no provider call.
    registerIdentityRoutes(app,options.sessions,createIdentitySummary(pool));
    // Secure unbind of the subject's own email + password login method. It is wired only together
    // with the mail service, because the design's unbind transaction must also notify the removed
    // address (12.3): a deployment without a mail path keeps this endpoint closed rather than
    // removing a login method silently. The notice and the removal share one transaction.
    if (options.email) registerIdentityUnlinkRoutes(app,createIdentityUnlinkService(pool,options.sessions,options.email.securityNotice));
    registerFamilyRoutes(app,pool,options.sessions,createFamilyRepository(pool));
    registerDeletionFamilyActions(app,pool,options.sessions);
    registerFamilyManagementAcceptanceRoutes(app,
      createFamilyManagementAcceptanceService(pool,options.sessions));
    if(options.familyInvitations)registerFamilyInvitationRoutes(app,options.familyInvitations);
    if(options.guardianship)registerGuardianRoutes(app,options.guardianship);
    if(options.childDevices)registerChildDeviceRoutes(app,options.childDevices);
    if(options.devicePairings)registerChildDevicePairingRoutes(app,options.devicePairings);
  }
  if (options.email) registerEmailRoutes(app,options.email);
  if(options.apple)registerAppleRoutes(app,options.apple);
  return app;
}
