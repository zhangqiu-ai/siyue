import {readRegistrationPolicy} from './registration-policy.js';
import {createAccountDeletionAcceptKernel} from './modules/auth/account-deletion-accept.js';
import {createAccountDeletionSubmission} from './modules/auth/account-deletion-submission.js';
import {createAccountDeletionIdempotencyStore} from './modules/auth/account-deletion-idempotency.js';
import {createAccountDeletionImpactService} from './modules/auth/account-deletion-impact.js';
import {createAccountDeletionJobStore} from './modules/auth/account-deletion-jobs.js';
import {createAppleRevocationOutbox} from './identities/apple/revocation-outbox.js';
import type {AppleRoutes} from './identities/apple/routes.js';
import {createAppleFlowStorage} from './identities/apple/flow-storage.js';
import {createAppleIdentityStorage} from './identities/apple/identity-storage.js';
import {createAppleIdentityVerifier} from './identities/apple/identity.js';
import {createAppleCodeExchange} from './identities/apple/exchange.js';
import {createAppleLoginPreparation} from './identities/apple/prepare-login.js';
import {createAppleLoginService} from './identities/apple/login-service.js';
import {createAppleRequestGate} from './identities/apple/request-gate.js';
import { createApp } from './app.js';
import { readDatabaseConfig } from './config.js';
import { readAuthConfig } from './auth-config.js';
import { createDatabasePool } from './adapters/postgres/database.js';
import { assertDatabaseReady } from './adapters/postgres/migrate.js';
import { createSessionService } from './modules/auth/sessions.js';
import { createFamilyInvitationService } from './modules/families/invitations.js';
import { createGuardianshipService } from './modules/families/guardianship.js';
import { createChildDeviceService } from './modules/families/child-devices.js';
import { createChildDevicePairingService } from './modules/families/device-pairings.js';
import { createRuntimeApp } from './runtime-app.js';
import { createEmailService } from './modules/auth/email.js';
import { createPasswordService } from './modules/auth/passwords.js';
import { readDeletionLedgerRuntimeConfig } from './account-deletion-ledger/runtime-config.js';
import { createDeletionLedgerStore } from './account-deletion-ledger/ledger-store.js';
import { createDeletionLedgerGate } from './account-deletion-ledger/login-gate.js';
import { createDeletionReplayKernel } from './account-deletion-ledger/replay.js';
import { createPreparedReconciler } from './account-deletion-ledger/prepared-reconciler.js';
import { createDeletionLedgerFenceStore, compareLedgerFence } from './account-deletion-ledger/fence.js';
import { createDeletionStartupRecovery, hasUnresolvedDeletionState } from './account-deletion-ledger/startup-recovery.js';
import { createAccountDeletionGuardedCleanupRunner } from './modules/auth/account-deletion-guarded-runner.js';
import { createAccountDeletionGuardedRevocationRunner } from './modules/auth/account-deletion-guarded-revocation-runner.js';
import { createAppleRevocationPostgresStore } from './identities/apple/revocation-postgres.js';
import { createAppleTokenRevocation } from './identities/apple/revocation.js';
import { createFamilyManagementAcceptanceService } from './modules/auth/family-management-acceptance.js';

async function main() {
  const environment=process.env.SIYUE_ENVIRONMENT ?? 'development';
  if(!process.env.SIYUE_DATABASE_URL) {
    if(environment!=='development' || process.env.NODE_ENV==='production') throw new Error('database_configuration_required');
    const app=createApp();
    await app.listen({host:'127.0.0.1',port:Number(process.env.SIYUE_SERVER_PORT ?? 8787)});
    return;
  }
  const config=readDatabaseConfig(process.env);
  const ledgerConfig=readDeletionLedgerRuntimeConfig(process.env,config.identity.environment);
  if(process.env.NODE_ENV==='production' && !['production','staging'].includes(config.identity.environment)) throw new Error('invalid_environment');
  const auth=await readAuthConfig(process.env);
  const registrationPolicy=await readRegistrationPolicy(process.env);
  const pool=createDatabasePool(config.connectionString,config.maxConnections);
  const ledgerPool=ledgerConfig?createDatabasePool(ledgerConfig.connectionString,2):undefined;
  try {
    await assertDatabaseReady(pool,config.identity);
    const ledger=ledgerPool&&ledgerConfig
      ?createDeletionLedgerStore(ledgerPool,ledgerConfig.identity):undefined;
    const fence=ledger?createDeletionLedgerFenceStore(pool):undefined;
    const recovery=ledger&&fence?createDeletionStartupRecovery({pool,fence,ledger,
      replay:createDeletionReplayKernel(pool,ledger)}):undefined;
    if(ledger&&fence){
      const decision=compareLedgerFence(await fence.read(),await ledger.highWater());
      if(decision==='ledger_replaced'||decision==='ledger_regressed')
        throw new Error('deletion_ledger_fence_conflict');
      const prepared=await createPreparedReconciler(pool,ledger).reconcile();
      if(prepared.ledgerError||prepared.unresolved.length)throw new Error('deletion_prepared_unresolved');
      const recovered=await recovery!.recover();
      if(!recovered.openLogin)throw new Error('deletion_recovery_incomplete');
    }
    const sessions=createSessionService(pool,auth.signer,auth.cipher,undefined,
      ledger?{loginGate:createDeletionLedgerGate(ledger)}:{});
    await sessions.clearExpiredRecovery();
    const familyInvitations=createFamilyInvitationService(pool,sessions,auth.cipher,auth.pepper);
    await familyInvitations.cleanupExpired();
    const guardianship=createGuardianshipService(pool,sessions,auth.pepper);
    await guardianship.cleanupExpired();
    const childDevices=createChildDeviceService(pool,sessions);
    const managementAcceptances=createFamilyManagementAcceptanceService(pool,sessions);
    await managementAcceptances.cleanupExpired();
    const devicePairings=createChildDevicePairingService(pool,sessions,auth.cipher,auth.pepper);
    await devicePairings.cleanupExpired();
    const email=auth.mail ? createEmailService(pool,sessions,await createPasswordService(),auth.cipher,auth.pepper,undefined,{registrationPolicy}) : undefined;
    const appleStorage=auth.apple?createAppleFlowStorage(pool,auth.cipher,auth.apple.clientId):undefined;
    let apple:AppleRoutes|undefined;
    if(auth.apple&&appleStorage){
      const verify=createAppleIdentityVerifier(auth.apple.clientId);
      const preparation=createAppleLoginPreparation({storage:appleStorage,requestPepper:auth.pepper,verify,exchange:await createAppleCodeExchange(auth.apple,{verify})});
      apple={service:createAppleLoginService({preparation,storage:appleStorage,identities:createAppleIdentityStorage(auth.cipher,auth.apple.namespace),sessions}),gate:createAppleRequestGate(pool,auth.pepper)};
      await appleStorage.cleanup();
      await apple.gate.cleanup();
    }
    const deletionReady=ledger&&fence?async()=>{
      try{return compareLedgerFence(await fence.read(),await ledger.highWater())==='ready'
        && !await hasUnresolvedDeletionState(pool);}
      catch{return false;}
    }:undefined;
    const deletionIdempotency=createAccountDeletionIdempotencyStore(pool,auth.cipher,auth.pepper);
    // Acceptance only queues Apple revocation in the same transaction. The guarded maintenance
    // worker below owns external calls, so acceptance never needs to contact a provider.
    const deletionQueue=createAppleRevocationOutbox({store:createAppleRevocationPostgresStore(pool),
      cipher:auth.cipher,revoke:async()=>{throw new Error('acceptance_cannot_call_provider');}});
    const deletionSubmission=ledger?createAccountDeletionSubmission(pool,
      createAccountDeletionAcceptKernel(pool,sessions,createAccountDeletionImpactService(pool,sessions),
        createAccountDeletionJobStore(pool),deletionQueue,ledger,undefined,deletionIdempotency),
      deletionIdempotency,ledger):undefined;
    const app=createRuntimeApp(pool,config.identity,{registrationPolicy,trustedProxyCidrs:config.trustedProxyCidrs,sessions,
      ...(deletionReady?{deletionReady}:{}),...(deletionSubmission?{deletionSubmission}:{}),familyInvitations,guardianship,childDevices,devicePairings,
      ...(email?{email}:{}),...(apple?{apple}:{})});
    const deletionCleanup=ledger?createAccountDeletionGuardedCleanupRunner(pool,{ledger}):undefined;
    const appleRevocations=ledger&&auth.apple?createAccountDeletionGuardedRevocationRunner(pool,{
      ledger,store:createAppleRevocationPostgresStore(pool),cipher:auth.cipher,
      revoke:await createAppleTokenRevocation(auth.apple)}):undefined;
    const deletionMaintenance=async()=>{
      if(!ledger||!fence||!recovery||!deletionCleanup)return;
      const point=await ledger.highWater();
      const decision=compareLedgerFence(await fence.read(),point);
      if(decision==='ledger_replaced'||decision==='ledger_regressed')return;
      if(decision==='replay_required'){
        const prepared=await createPreparedReconciler(pool,ledger).reconcile();
        if(prepared.ledgerError||prepared.unresolved.length)return;
        const recovered=await recovery.recover();
        if(!recovered.openLogin)return;
      }
      if(await hasUnresolvedDeletionState(pool))return;
      await appleRevocations?.sweep();
      await deletionCleanup.sweep();
    };
    // One maintenance cycle per process; the ledger and cleanup kernels keep their own bounds.
    let cleanupActive=false;
    const cleanup=setInterval(()=>{
      if(cleanupActive) return;
      cleanupActive=true;
      void Promise.all([sessions.clearExpiredRecovery(),familyInvitations.cleanupExpired(),guardianship.cleanupExpired(),devicePairings.cleanupExpired(),managementAcceptances.cleanupExpired(),appleStorage?.cleanup(),apple?.gate.cleanup(),deletionMaintenance()]).catch(()=>{}).finally(()=>{cleanupActive=false;});
    },30_000);
    cleanup.unref();
    app.addHook('onClose',async()=>{clearInterval(cleanup);await Promise.all([pool.end(),ledgerPool?.end()]);});
    for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void app.close();});
    try { await app.listen({host:config.host,port:config.port}); }
    catch(error) {await app.close();throw error;}
  } catch(error) {
    await Promise.all([!pool.ended?pool.end():undefined,ledgerPool&&!ledgerPool.ended?ledgerPool.end():undefined]);
    throw error;
  }
}
main().catch(()=>{console.error('Siyue server startup failed; verify runtime configuration, secrets and schema.');process.exitCode=1;});
