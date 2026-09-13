import type { CompatibleConfig } from '../chat/compatible-transport.ts';
import { SettingsError } from '../settings/credential-store.ts';

type PlanSettingsState = {
  ready: boolean;
  config: Omit<CompatibleConfig, 'apiKey'> | null;
  storageError: string | null;
};

/** Distinguish an unavailable secure store from a user who has not configured AI. */
export function requirePlanSettings(settings: PlanSettingsState): void {
  if (settings.storageError) throw new SettingsError(settings.storageError);
  if (!settings.ready || !settings.config) {
    throw Object.assign(new Error('AI configuration is required'), {code: 'configuration_required'});
  }
}
