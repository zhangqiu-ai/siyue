import { NativeModule, requireNativeModule } from 'expo';
import type { OfflineClockSnapshot } from './SiyueOfflineClock.types';

declare class SiyueOfflineClockNativeModule extends NativeModule<{}> {
  snapshot(): unknown;
}

const nativeModule = requireNativeModule<SiyueOfflineClockNativeModule>('SiyueOfflineClock');

export function getOfflineClockSnapshot(): OfflineClockSnapshot {
  const value = nativeModule.snapshot();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_native_clock');
  const candidate = value as Partial<OfflineClockSnapshot>;
  if (typeof candidate.bootId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.bootId) ||
      typeof candidate.elapsedRealtimeMs !== 'number' || !Number.isFinite(candidate.elapsedRealtimeMs) || candidate.elapsedRealtimeMs < 0) {
    throw new Error('invalid_native_clock');
  }
  return Object.freeze({bootId: candidate.bootId, elapsedRealtimeMs: candidate.elapsedRealtimeMs});
}
