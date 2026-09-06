import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { streamCompatibleReply, type CompatibleConfig } from '../chat/compatible-transport';
import { createCredentialStore, SettingsError } from './credential-store';

const key = 'siyue.ai.configuration.v1';
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const store = createCredentialStore({
  read: () => SecureStore.getItemAsync(key, options),
  write: (value) => SecureStore.setItemAsync(key, value, options),
  remove: () => SecureStore.deleteItemAsync(key, options),
});
type PublicConfig = Omit<CompatibleConfig, 'apiKey'>;
type Settings = {
  ready: boolean; config: PublicConfig | null; hasKey: boolean; storageError: string | null;
  revision: number; getSessionSignal: () => AbortSignal;
  getCredentials: () => Promise<CompatibleConfig>;
  save: (input: CompatibleConfig) => Promise<void>;
  remove: () => Promise<void>;
  testConnection: (signal: AbortSignal) => Promise<void>;
};
const Context = createContext<Settings | null>(null);
const publicConfig = (value: CompatibleConfig | null): PublicConfig | null => value ? { baseUrl: value.baseUrl, model: value.model } : null;

export function AISettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const session = useRef(new AbortController());
  useEffect(() => {
    if (session.current.signal.aborted) session.current = new AbortController();
    let mounted = true;
    void store.load().then((value) => { if (mounted) setConfig(publicConfig(value)); })
      .catch(() => { if (mounted) setStorageError('无法读取 AI 安全配置，请在设置中重新保存或移除。'); })
      .finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; session.current.abort(); };
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        session.current.abort();
        session.current = new AbortController();
      }
    });
    return () => subscription.remove();
  }, []);
  const getCredentials = async () => {
    const value = await store.load();
    if (!value) throw new SettingsError('请先在设置中配置 AI 服务和密钥。');
    return value;
  };
  const replaceSession = () => {
    session.current.abort();
    session.current = new AbortController();
    setRevision((value) => value + 1);
  };
  return <Context.Provider value={{
    ready, config, hasKey: config !== null, storageError, revision, getSessionSignal: () => session.current.signal, getCredentials,
    save: async (input) => {
      const value = await store.save(input);
      replaceSession(); setConfig(publicConfig(value)); setStorageError(null);
    },
    remove: async () => {
      await store.remove();
      replaceSession(); setConfig(null); setStorageError(null);
    },
    testConnection: async (signal) => {
      const sessionSignal = session.current.signal;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      sessionSignal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted || sessionSignal.aborted) controller.abort();
        const credentials = await getCredentials();
        for await (const _text of streamCompatibleReply(credentials, [{ role: 'user', content: '请只回复 OK' }], controller.signal, expoFetch)) { /* Do not store or log the response. */ }
        if (controller.signal.aborted) throw new SettingsError('连接测试已取消。');
      } finally {
        signal.removeEventListener('abort', abort);
        sessionSignal.removeEventListener('abort', abort);
        controller.abort();
      }
    },
  }}>{children}</Context.Provider>;
}

export function useAISettings() {
  const settings = useContext(Context);
  if (!settings) throw new Error('AISettingsProvider is required');
  return settings;
}
