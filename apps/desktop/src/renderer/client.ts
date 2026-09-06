import type { LocalClient } from '@siyue/adapters';
import { canonicalize } from '@siyue/domain';
import { businessCommandSchema, commandEnvelopeSchema, commandReceiptSchema } from '@siyue/contracts';

type Reply = { ok: true; value: unknown } | { ok: false; error: { code: string } };
type Bridge = { invoke: (message: { requestId: string; method: string; args: unknown[] }) => Promise<Reply>; cancel: (requestId: string) => void };
type PendingOperation = { commandId: string; issuedAt: string };
type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const failure = (code: string) => Object.assign(new Error(code), { code });
const pendingPrefix = 'siyue.pending-command.v1.';
const pendingOperationSchema = commandEnvelopeSchema.pick({ commandId: true, issuedAt: true });
async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createDesktopClient(environment?: { bridge?: Bridge; storage: PendingStorage }): LocalClient {
  const bridge = environment ? environment.bridge : (window as unknown as { siyueDesktop?: Bridge }).siyueDesktop;
  const storage = environment ? environment.storage : window.localStorage;
  async function invoke(method: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    if (!bridge) throw failure('unsupported');
    if (signal?.aborted) throw failure('cancelled');
    const requestId = crypto.randomUUID();
    const cancel = () => bridge.cancel(requestId);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await bridge.invoke({ requestId, method, args });
      if (!response.ok) throw failure(response.error.code);
      return response.value;
    } finally { signal?.removeEventListener('abort', cancel); }
  }
  async function write(method: 'saveManual' | 'update', args: unknown[]) {
    // Keep the existing key format, but freeze caller-owned inputs before hashing.
    const input = JSON.parse(JSON.stringify(args)) as unknown[];
    const fingerprint = await hash([method, input]);
    const key = pendingPrefix + fingerprint;
    const saved = storage.getItem(key);
    let operation: PendingOperation;
    if (saved !== null) {
      let value: unknown;
      try { value = JSON.parse(saved); } catch { throw failure('corrupt_data'); }
      const parsed = pendingOperationSchema.safeParse(value);
      if (!parsed.success) throw failure('corrupt_data');
      operation = parsed.data;
    } else {
      operation = { commandId: crypto.randomUUID(), issuedAt: new Date().toISOString() };
      // Persist the identity before dispatch. This contains no draft/body text.
      storage.setItem(key, JSON.stringify(operation));
    }
    const persisted = saved ?? JSON.stringify(operation);
    const clear = () => { if (storage.getItem(key) === persisted) storage.removeItem(key); };
    const verifiedReceipt = async (value: unknown) => {
      const receipt = commandReceiptSchema.safeParse(value);
      if (!receipt.success || receipt.data.commandId !== operation.commandId) throw failure('failed');
      // The trusted host scopes receipt lookup to its current actor and space.
      // Reconstruct the same normalized command as IPC before accepting its hash.
      const command = businessCommandSchema.safeParse({
        schemaVersion: 1, spaceId: receipt.data.spaceId, ...operation,
        ...(method === 'saveManual' ? { kind: 'plan.create', payload: input[0] } : {
          kind: `${input[0]}.update`, entityId: input[1], expectedVersion: input[2], patch: input[3],
        }),
      });
      if (!command.success || receipt.data.payloadHash !== await hash(command.data)) throw failure('failed');
      return receipt.data;
    };
    const reconcile = async () => {
      const receipt = await invoke('receipt', [operation.commandId]);
      if (!receipt) return null;
      const verified = await verifiedReceipt(receipt);
      clear();
      return verified;
    };
    if (saved !== null) {
      const receipt = await reconcile();
      if (receipt) return receipt;
    }
    try {
      const result = await verifiedReceipt(await invoke(method, [...input, operation]));
      clear();
      return result;
    } catch (error) {
      try {
        const receipt = await reconcile();
        if (receipt) return receipt;
      } catch { /* Unknown status: retain the same operation for recovery. */ }
      throw error;
    }
  }
  return {
    snapshot: () => invoke('snapshot', []) as ReturnType<LocalClient['snapshot']>,
    propose: (goal, signal) => invoke('propose', [goal], signal) as ReturnType<LocalClient['propose']>,
    saveManual: (payload) => write('saveManual', [payload]) as ReturnType<LocalClient['saveManual']>,
    editDraft: (id, version, payload) => invoke('editDraft', [id, version, payload]) as ReturnType<LocalClient['editDraft']>,
    confirmDraft: (id, version) => invoke('confirmDraft', [id, version]) as ReturnType<LocalClient['confirmDraft']>,
    discardDraft: (id, version) => invoke('discardDraft', [id, version]) as ReturnType<LocalClient['discardDraft']>,
    update: (kind, id, version, patch) => write('update', [kind, id, version, patch]) as ReturnType<LocalClient['update']>,
    receipt: (commandId) => invoke('receipt', [commandId]) as ReturnType<LocalClient['receipt']>,
  };
}
export async function getClient(): Promise<LocalClient> { return createDesktopClient(); }
