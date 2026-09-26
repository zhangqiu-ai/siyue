import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountLoginMethod } from '@siyue/contracts';
import { useAccountAuth } from '../auth-provider';

export interface AccountHomeData {
  readonly methods: readonly AccountLoginMethod[] | null;
  readonly deviceCount: number | null;
  readonly pendingFamilies: number | null;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
}

/** The reads the account home needs to answer at a glance: which ways this account signs in, how many
 *  devices use it, and whether a family handover waits for the caller. Each answer is independent, so
 *  one unreadable list neither blanks the page nor invents a count for another row. */
export function useHomeData(): AccountHomeData {
  const { client, state } = useAccountAuth();
  const [methods, setMethods] = useState<readonly AccountLoginMethod[] | null>(null);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [pendingFamilies, setPendingFamilies] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const live = useRef(true);
  const generation = state.generation;
  const adult = state.session?.subjectKind !== 'child';

  const reload = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    const own = generation;
    // A generation that has moved on belongs to a different subject, so its answers are dropped rather
    // than shown against the next account.
    const keep = () => live.current && client.getState().generation === own;
    const reads: [Promise<unknown>, (value: unknown) => void][] = [
      [client.loginMethods(), value => setMethods((value as { items: readonly AccountLoginMethod[] }).items)],
      [client.deviceSessions(), value => { const page = value as { items: readonly unknown[]; nextCursor: string | null };
        setDeviceCount(page.nextCursor ? null : page.items.length); }],
    ];
    if (adult) reads.push([client.familyResponsibilities(), value => setPendingFamilies((value as readonly unknown[]).length)]);
    const answers = await Promise.allSettled(reads.map(([read]) => read));
    if (keep()) answers.forEach((answer, index) => { if (answer.status === 'fulfilled') reads[index][1](answer.value); });
    if (live.current) setLoading(false);
  }, [adult, client, generation]);

  useEffect(() => {
    live.current = true;
    setMethods(null); setDeviceCount(null); setPendingFamilies(null);
    void reload();
    return () => { live.current = false; };
  }, [reload]);

  return { methods, deviceCount, pendingFamilies, loading, reload };
}
