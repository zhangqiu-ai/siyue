/** Debounced autosave for the plan draft editor.
 * Framework-free on purpose: timers and the clock are injected, so the controller is
 * testable without React, a simulator or a real device. Saves are serialised per
 * controller and the newest payload always wins.
 */

export type DraftAutosaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export interface DraftAutosaveState<TPayload> {
  /** idle: unsaved changes wait for the debounce; saving: a save is in flight; saved: nothing is pending; error: the last attempt failed. */
  readonly status: DraftAutosaveStatus;
  /** Version returned by the last successful save, or 0 when no save has succeeded yet. */
  readonly version: number;
  readonly savedAt: number | null;
  readonly error: unknown | null;
  /** True while the stored payload has not been persisted by a successful save. */
  readonly dirty: boolean;
}
export interface DraftAutosaveOptions<TPayload> {
  /** One save attempt. It must resolve with the persisted draft version and must not be called concurrently. */
  save: (payload: TPayload) => Promise<{version: number}>;
  delayMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}
export interface DraftAutosave<TPayload> {
  /** Replace the stored payload and restart the debounce. Ignored after dispose. */
  update(payload: TPayload): void;
  /** Persist the stored payload now: waits for in-flight and pending saves and resolves with the saved version.
   * Rejects with the retained error when the newest payload could not be saved, and with 'draft_autosave_disposed'
   * when a disposed controller still holds unsaved content. A resolved version of 0 means nothing was ever saved. */
  flush(): Promise<{version: number}>;
  /** Retry the retained payload immediately after a failed save; a no-op while nothing is pending or unsaved. */
  retry(): void;
  readonly status: DraftAutosaveStatus;
  /** Stable snapshot for subscription-based renderers; the identity changes only with the state. */
  getState(): DraftAutosaveState<TPayload>;
  subscribe(listener: (state: DraftAutosaveState<TPayload>) => void): () => void;
  /** Cancel pending work and detach listeners. An in-flight save is left to settle, no later payload is saved,
   * and further updates are ignored. */
  dispose(): void;
}

export function createDraftAutosave<TPayload>(options: DraftAutosaveOptions<TPayload>): DraftAutosave<TPayload> {
  const delayMs = options.delayMs ?? 600;
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('draft_autosave_invalid_delay');
  const now: () => number = options.now ?? Date.now;
  const setTimer: (callback: () => void, delayMs: number) => unknown = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer: (handle: unknown) => void = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<(state: DraftAutosaveState<TPayload>) => void>();
  let status: DraftAutosaveStatus = 'idle';
  let version = 0, savedAt: number | null = null, error: unknown = null;
  let stored: TPayload | undefined;
  let pending = false, disposed = false;
  let timer: unknown, timerScheduled = false;
  let inFlight: Promise<void> | null = null;
  function state(): DraftAutosaveState<TPayload> { return {status, version, savedAt, error, dirty: pending}; }
  // Published snapshots keep their identity so renderers can compare them cheaply.
  let published = state();
  function publish() {
    const next = state();
    if (next.status === published.status && next.version === published.version && next.savedAt === published.savedAt &&
        next.error === published.error && next.dirty === published.dirty) return;
    published = next;
    for (const listener of [...listeners]) listener(next);
  }
  function cancelTimer() { if (timerScheduled) { clearTimer(timer); timerScheduled = false; } }
  function schedule() {
    cancelTimer();
    timer = setTimer(() => { timerScheduled = false; void drive(); }, delayMs);
    timerScheduled = true;
  }
  /** One serialised save loop: the pending payload is saved, then any newer payload that arrived meanwhile. */
  function drive(): Promise<void> {
    if (inFlight) return inFlight;
    // The body starts in a microtask so that a re-entrant caller (for example a listener
    // reacting to "saving") observes inFlight instead of starting a second loop.
    const run = Promise.resolve().then(async () => {
      // A failed attempt keeps the payload and stops here until retry() or a new update clears the error.
      while (!disposed && pending && error === null) {
        const payload = stored as TPayload;
        status = 'saving'; publish();
        let result: {version: number} | undefined;
        try { result = await options.save(payload); }
        catch (cause) { error = cause; status = 'error'; publish(); return; }
        if (!result || !Number.isInteger(result.version) || result.version <= 0) {
          error = new Error('draft_autosave_invalid_version'); status = 'error'; publish(); return;
        }
        version = result.version; savedAt = now();
        if (stored === payload) pending = false;
        status = 'saved'; publish();
      }
    });
    inFlight = run;
    void run.then(() => {
      if (inFlight !== run) return;
      inFlight = null;
      // An update that landed after the loop stopped still has to be saved.
      if (!disposed && pending && error === null) void drive();
    }, () => undefined);
    return run;
  }
  return {
    update(payload: TPayload) {
      if (disposed) return;
      stored = payload; pending = true; error = null;
      if (!inFlight) status = 'idle';
      publish();
      schedule();
    },
    async flush() {
      cancelTimer();
      if (!disposed) await drive();
      if (pending) throw error ?? new Error(disposed ? 'draft_autosave_disposed' : 'draft_autosave_failed');
      return {version};
    },
    retry() {
      if (disposed || !pending) return;
      error = null;
      cancelTimer();
      // A running loop finishes its own attempt and then picks up the retry through its completion check.
      if (inFlight) return;
      void drive();
    },
    get status() { return status; },
    getState() { return published; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      disposed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
