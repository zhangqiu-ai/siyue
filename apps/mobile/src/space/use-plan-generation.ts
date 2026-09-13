import { useCallback } from 'react';
import { AppState } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { getClient } from '../client';
import { useAISettings } from '../settings/ai-settings';
import { proposePlan } from './propose-plan';
import { requirePlanSettings } from './plan-settings';

export function usePlanGeneration() {
  const settings = useAISettings();
  return useCallback((goal: string, signal: AbortSignal) => {
    try { requirePlanSettings(settings); }
    catch (error) { return Promise.reject(error); }
    return proposePlan(goal, getClient, {
      getCredentials: settings.getCredentials,
      getSessionSignal: settings.getSessionSignal,
      isActive: () => AppState.currentState === 'active',
      fetcher: expoFetch,
    }, signal);
  }, [settings]);
}
