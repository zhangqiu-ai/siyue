import type { CompatibleConfig } from '../chat/compatible-transport.ts';

export type AISettingsSession = {
  getSignal: () => AbortSignal;
  replace: () => void;
  dispose: () => void;
};

export function createAISettingsSession(): AISettingsSession {
  let current = new AbortController();
  return {
    getSignal: () => current.signal,
    replace: () => {
      current.abort();
      current = new AbortController();
    },
    dispose: () => current.abort(),
  };
}

type SettingsStore = {
  save: (input: CompatibleConfig) => Promise<CompatibleConfig>;
  remove: () => Promise<void>;
};

export async function saveAndReplaceSession(store: SettingsStore, input: CompatibleConfig, session: AISettingsSession) {
  const value = await store.save(input);
  session.replace();
  return value;
}

export async function removeAndReplaceSession(store: SettingsStore, session: AISettingsSession) {
  await store.remove();
  session.replace();
}

export function replaceSessionForAppState(session: AISettingsSession, state: string): boolean {
  if (state === 'active') return false;
  session.replace();
  return true;
}
