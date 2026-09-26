// Classification of a failed reply. Only these short codes are stored on a message, so a stored
// conversation never carries provider text, credentials or transport details.
import type { MessageKey } from '../i18n/core.ts';
import { SettingsError } from '../settings/credential-store.ts';
import { CompatibleChatError, type CompatibleErrorCode } from './compatible-transport.ts';

export type ChatErrorCode =
  | 'unconfigured' | 'auth' | 'rate_limit' | 'timeout' | 'network' | 'service'
  | 'incomplete' | 'length' | 'invalid' | 'too_long' | 'unknown';

const byTransportCode: Record<CompatibleErrorCode, ChatErrorCode> = {
  invalid_url: 'invalid',
  invalid_config: 'unconfigured',
  auth: 'auth',
  rate_limit: 'rate_limit',
  service: 'service',
  malformed: 'invalid',
  empty: 'invalid',
  length: 'length',
  filtered: 'incomplete',
  tools: 'invalid',
  interrupted: 'incomplete',
  timeout: 'timeout',
  network: 'network',
  unknown: 'unknown',
};

export const chatErrorMessages: Record<ChatErrorCode, MessageKey> = {
  unconfigured: 'chat.errorUnconfigured',
  auth: 'chat.errorAuth',
  rate_limit: 'chat.errorRateLimit',
  timeout: 'chat.errorTimeout',
  network: 'chat.errorNetwork',
  service: 'chat.errorService',
  incomplete: 'chat.errorIncomplete',
  length: 'chat.errorLength',
  invalid: 'chat.errorInvalid',
  too_long: 'chat.errorTooLong',
  unknown: 'chat.errorUnknown',
};

export function chatErrorCode(error: unknown): ChatErrorCode {
  if (error instanceof CompatibleChatError) return byTransportCode[error.code] ?? 'unknown';
  // SettingsError is raised before any request: either nothing is configured or the transcript
  // would exceed what this app sends in one turn.
  if (error instanceof SettingsError) return /过长/.test(error.message) ? 'too_long' : 'unconfigured';
  return 'unknown';
}
