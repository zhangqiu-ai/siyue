import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { createEmailEntry } from '@siyue/adapters';
import { useAccountAuth } from '../auth-provider';

export function useEmailEntry(mode: 'login' | 'reset-request') {
  const { client, state } = useAccountAuth();
  const [flow] = useState(() => client ? createEmailEntry({
    login: input => client.login({ ...input, platform: Platform.OS === 'ios' ? 'ios' : 'android' }),
    requestReset: client.requestReset,
    confirmReset: client.confirmReset,
  }, Crypto.randomUUID) : null);
  const form = useSyncExternalStore(flow?.subscribe ?? (() => () => {}), flow?.getState ?? (() => null), flow?.getState ?? (() => null));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    flow?.navigate(mode);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); flow?.dispose(); };
  }, [flow, mode]);
  useEffect(() => { if (flow && state.account?.subjectId) flow.navigate('login'); }, [flow, state.account?.subjectId]);
  return { flow, form, now, state, client };
}
