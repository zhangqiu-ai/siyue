import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { PlanSnapshot } from '@siyue/adapters';
import { getClient } from '../client';
import { errorCode } from './draft-actions.ts';

export type PlanUpdateResult = { kind: 'applied' } | { kind: 'conflict' } | { kind: 'failed' };

/** Read the formal plan state and write single-entity patches against its versions.
 * A write never guesses the new version: the next snapshot is the only source of it. */
export function usePlanSnapshot() {
  const [snapshot, setSnapshot] = useState<PlanSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; latest.current += 1; };
  }, []);
  const read = useCallback(async (): Promise<PlanSnapshot | null> => {
    const request = ++latest.current;
    try {
      const data = await (await getClient()).snapshot();
      if (mounted.current && request === latest.current) setSnapshot(data);
      return data;
    } catch {
      if (mounted.current && request === latest.current) setFailed(true);
      return null;
    }
  }, []);
  const reload = useCallback(async () => {
    if (lock.current) return;
    setLoading(true);
    setFailed(false);
    await read();
    if (mounted.current) setLoading(false);
  }, [read]);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));
  const update = useCallback(async (kind: 'goal' | 'project' | 'task', id: string, version: number, patch: Record<string, unknown>): Promise<PlanUpdateResult> => {
    if (lock.current) return { kind: 'failed' };
    lock.current = true;
    try {
      const client = await getClient();
      await client.update(kind, id, version, patch as Parameters<typeof client.update>[3]);
      await read();
      return { kind: 'applied' };
    } catch (error) {
      if (!mounted.current) return { kind: 'failed' };
      if (errorCode(error) === 'version_conflict') {
        // The other device's copy wins only after it is read back; nothing is merged locally.
        await read();
        return { kind: 'conflict' };
      }
      setFailed(true);
      return { kind: 'failed' };
    } finally {
      lock.current = false;
    }
  }, [read]);
  const addTask = useCallback(async (goalId: string, title: string, projectId?: string): Promise<PlanUpdateResult> => {
    if (lock.current) return { kind: 'failed' };
    lock.current = true;
    try {
      const client = await getClient();
      await client.addTaskToGoal(goalId, title, projectId);
      // A verified command receipt means the task is saved even if this refresh fails.
      await read();
      return { kind: 'applied' };
    } catch (error) {
      if (!mounted.current) return { kind: 'failed' };
      if (errorCode(error) === 'version_conflict' || errorCode(error) === 'not_found') {
        await read();
        return { kind: 'conflict' };
      }
      return { kind: 'failed' };
    } finally {
      lock.current = false;
    }
  }, [read]);
  return { snapshot, loading, failed, reload, update, addTask };
}
