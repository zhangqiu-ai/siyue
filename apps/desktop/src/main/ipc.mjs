import { businessCommandSchema, commandEnvelopeSchema, goalDraftSchema } from '@siyue/contracts';

const knownErrors = new Set(['invalid_input', 'forbidden', 'not_found', 'version_conflict', 'command_conflict', 'approval_required', 'approval_invalid', 'approval_expired', 'invalid_state', 'id_collision', 'unsupported_schema', 'corrupt_data', 'space_not_found', 'closed', 'cancelled', 'timeout', 'failed', 'unsupported', 'busy']);
export function publicError(error) {
  return { ok: false, error: { code: error?.name === 'AbortError' ? 'cancelled' : knownErrors.has(error?.code) ? error.code : 'failed' } };
}
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;
const isVersion = (value) => Number.isSafeInteger(value) && value > 0;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export function isTrustedSender(event, webContents, rendererUrl) {
  return !webContents.isDestroyed() && event.sender === webContents &&
    event.senderFrame === webContents.mainFrame &&
    event.senderFrame?.url === rendererUrl && webContents.getURL() === rendererUrl;
}

function validateOperation(operation) {
  if (!plain(operation) || Object.keys(operation).length !== 2 || !Object.hasOwn(operation, 'commandId') || !Object.hasOwn(operation, 'issuedAt')) fail('invalid_input');
  const parsed = commandEnvelopeSchema.safeParse({ schemaVersion: 1, spaceId: 'local', ...operation });
  if (!parsed.success) fail('invalid_input');
  return { commandId: parsed.data.commandId, issuedAt: parsed.data.issuedAt };
}

export function validateCall(message) {
  if (!plain(message) || Object.keys(message).length !== 3 || !Object.hasOwn(message, 'requestId') ||
      !Object.hasOwn(message, 'method') || !Object.hasOwn(message, 'args') || !isId(message.requestId) || !Array.isArray(message.args)) fail('invalid_input');
  const { method, args } = message;
  if (method === 'snapshot' && args.length === 0) return args;
  if (method === 'propose' && args.length === 1 && typeof args[0] === 'string' && args[0].trim().length > 0 && args[0].length <= 160) return [args[0].trim()];
  if (method === 'receipt' && args.length === 1 && isId(args[0])) return args;
  if (method === 'saveManual' && (args.length === 1 || args.length === 2)) {
    const payload = goalDraftSchema.safeParse(args[0]);
    if (payload.success) return args.length === 1 ? [payload.data] : [payload.data, validateOperation(args[1])];
  }
  if (['editDraft', 'confirmDraft', 'discardDraft'].includes(method) && isId(args[0]) && isVersion(args[1])) {
    if (method !== 'editDraft' && args.length === 2) return args;
    if (method === 'editDraft' && args.length === 3) {
      const payload = goalDraftSchema.safeParse(args[2]);
      if (payload.success) return [args[0], args[1], payload.data];
    }
  }
  if (method === 'update' && (args.length === 4 || args.length === 5) && ['goal', 'project', 'task'].includes(args[0])) {
    const parsed = businessCommandSchema.safeParse({
      schemaVersion: 1, commandId: 'ipc-validation', spaceId: 'local', issuedAt: '2026-01-01T00:00:00.000Z',
      kind: `${args[0]}.update`, entityId: args[1], expectedVersion: args[2], patch: args[3],
    });
    if (parsed.success) return args.length === 4 ? [args[0], args[1], args[2], parsed.data.patch] : [args[0], args[1], args[2], parsed.data.patch, validateOperation(args[4])];
  }
  fail('invalid_input');
}

/** One dispatcher per window. Neither identity nor database access crosses IPC. */
export function createIpcDispatcher({ client, webContents, rendererUrl }) {
  const pending = new Map();
  let disposed = false;
  return {
    async handle(event, message) {
      try {
        if (disposed || !isTrustedSender(event, webContents, rendererUrl)) fail('forbidden');
        const args = validateCall(message);
        if (pending.has(message.requestId)) fail('command_conflict');
        if (pending.size >= 16) fail('busy');
        const controller = new AbortController();
        pending.set(message.requestId, { controller, method: message.method });
        try {
          const result = message.method === 'propose'
            ? await client.propose(args[0], controller.signal)
            : await client[message.method](...args);
          return { ok: true, value: result };
        } finally { pending.delete(message.requestId); }
      } catch (error) { return publicError(error); }
    },
    cancel(event, requestId) {
      if (disposed || !isTrustedSender(event, webContents, rendererUrl) || !isId(requestId)) return;
      const request = pending.get(requestId);
      if (request?.method === 'propose') request.controller.abort();
    },
    dispose() {
      disposed = true;
      for (const request of pending.values()) request.controller.abort();
    },
  };
}
