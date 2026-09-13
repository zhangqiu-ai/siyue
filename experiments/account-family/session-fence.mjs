// Isolated V11 race model. Not authentication, durable storage or server authorization.
// Admission/commit are trusted, synchronous and must not reenter switchTo.
// This callback contract is not runtime-enforced. Dispatch may have committed remotely.
export function createSessionFence() {
  let current = null;
  let generation = 0;
  const issued = new WeakSet();
  const inflight = new Set();
  const validScope = s => s && ['subjectId', 'spaceId'].every(k => typeof s[k] === 'string' && s[k].length > 0);
  const sameScope = (a, b) => a?.subjectId === b?.subjectId && a?.spaceId === b?.spaceId;
  function switchTo(scope) {
    if (scope !== null && !validScope(scope)) throw Error('invalid_scope');
    generation++;
    current = scope === null ? null : Object.freeze({ subjectId: scope.subjectId, spaceId: scope.spaceId });
    for (const controller of inflight) controller.abort();
  }
  function stage(commandId, payload) {
    if (!current) throw Error('signed_out');
    if (typeof commandId !== 'string' || !commandId) throw Error('invalid_command');
    // Serialized payload represents an immutable queued command, never rebased on login.
    const work = Object.freeze({ commandId, scope: current, generation, payload: JSON.stringify(payload) });
    issued.add(work);
    return work;
  }
  const active = work => issued.has(work) && current !== null && work.generation === generation && sameScope(work.scope, current);
  async function execute(work, { authorize, dispatch, commit }) {
    if (!active(work)) return { status: 'stale' };
    const controller = new AbortController();
    inflight.add(controller);
    try {
      const allowed = await authorize(work.scope, controller.signal);
      if (!active(work)) return { status: 'stale' };
      if (allowed !== true) return { status: 'denied' };
      const receipt = await dispatch(work, controller.signal);
      if (!active(work)) return { status: 'stale' };
      if (!sameScope(receipt?.scope, work.scope) || receipt?.commandId !== work.commandId) throw Error('receipt_scope_mismatch');
      // No await between the final fence and this synchronous UI/cache commit.
      commit(receipt);
      return { status: 'applied' };
    } catch (error) {
      if (!active(work)) return { status: 'stale' };
      throw error;
    } finally {
      inflight.delete(controller);
    }
  }
  return { switchTo, stage, execute };
}
