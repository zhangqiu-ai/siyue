export { createSqliteStore, StorageError, type SqlConnection, type SqlValue } from './sqlite-store.js';
export { createLocalClient, type LocalClient, type PlanSnapshot, type LocalClientOptions, type LocalRequest, type RequestPlanProposer } from './local-client.js';
export type { AsyncKeyValueStore, RequestJournal } from './request-journal.js';
export { createSqliteRequestJournalStorage } from './sqlite-request-journal.js';
export {
  AccountSessionError,
  createAccountSessionClient,
  createAccountSessionCoordinator,
  type AccountSessionClient,
  type AccountSessionClientOptions,
  type AccountSessionErrorCode,
  type AccountSessionState,
} from './account-session-client.js';
export { createAuthApiClient, authEndpoint, AuthClientError, type AuthApiClient, type AuthEndpoint } from './auth-api-client.js';
export { createAuthController, type AuthController, type AuthVault, type AuthControllerOptions } from './auth-controller.js';
export { createEmailEntry, type EmailEntryActions, type EmailEntryState } from './email-entry.js';
export { createEmailRegistration, emailRegistrationActions, type EmailRegistrationActions,
  type EmailRegistrationController, type EmailRegistrationError, type EmailRegistrationHost,
  type EmailRegistrationState } from './email-registration.js';
export { createAccountSpaceCatalog } from './account-space-catalog.js';
export { createAccountWorkspace, type WorkspaceScope, type WorkspaceState } from './account-workspace.js';

export type {AppleAuthorize} from './apple-sign-in.js';
export {
  createChildDevicePairingClient,
  createGuardianChildDeviceClient,
  adultAccessToken,
  childDevicePairingPollIntervalMs,
  childDevicePairingRecoveryMs,
  type AdultAccessToken,
  type ChildDeviceApiOptions,
  type ChildDeviceCall,
  type ChildDevicePairingClient,
  type ChildDevicePairingOptions,
  type ChildDevicePairingTicket,
  type ChildDeviceSession,
  type GuardianChildDeviceClient,
} from './child-device-api-client.js';

export {createAccountDeletionFlow,type AccountDeletionFlow,type AccountDeletionFlowState,type AccountDeletionFlowController} from './account-deletion-flow.js';
