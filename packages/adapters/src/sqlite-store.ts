import { spaceStateSchema, type SpaceState } from '@siyue/contracts';
import { createSpaceState, type SpaceStore } from '@siyue/domain';

export type SqlValue = string | number | null;
export interface SqlConnection {
  exec(sql: string): Promise<void>;
  get<T>(sql: string, params: readonly SqlValue[]): Promise<T | null>;
  run(sql: string, params: readonly SqlValue[]): Promise<void>;
  transaction<T>(work: (transaction: SqlConnection) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
export class StorageError extends Error {
  constructor(public readonly code: 'unsupported_schema' | 'corrupt_data' | 'space_not_found' | 'closed', message: string) {
    super(message); this.name = 'StorageError';
  }
}

/** Temporary local-only snapshot adapter. One connection belongs to one store.
 * Every operation is serialized; transaction callbacks must use their state only,
 * never reenter this store or run network requests. No provider data leaves the host.
 */
export function createSqliteStore(connection: SqlConnection): SpaceStore & {
  initialize(ownerId: string, newSpaceId?: string): Promise<{spaceId: string; actorId: string}>;
  close(): Promise<void>;
} {
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;
  let ready = false;
  let active = connection;
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(() => {
      if (closed) throw new StorageError('closed', 'Database is closed');
      return work();
    });
    pending = result.catch(() => undefined);
    return result;
  }
  async function atomic<T>(work: () => Promise<T>): Promise<T> {
    return connection.transaction(async (transaction) => {
      active = transaction;
      try { return await work(); } finally { active = connection; }
    });
  }
  async function prepare() {
    if (ready) return;
    await atomic(async () => {
      const row = await active.get<{user_version: number}>('PRAGMA user_version', []);
      if (!row || row.user_version > 1 || row.user_version < 0) throw new StorageError('unsupported_schema', 'Database version is not supported');
      if (row.user_version === 0) {
        const tables = await active.get<{total: number}>("SELECT count(*) AS total FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'", []);
        if (!tables || tables.total !== 0) throw new StorageError('corrupt_data', 'Unversioned database contains existing objects');
        await active.exec('CREATE TABLE spaces (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL); PRAGMA user_version = 1;');
      }
      const table = await active.get<{name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spaces'", []);
      if (!table) throw new StorageError('corrupt_data', 'Spaces table is missing');
    });
    ready = true;
  }
  function validate(value: unknown, spaceId: string): SpaceState {
    const parsed = spaceStateSchema.safeParse(value);
    if (!parsed.success || parsed.data.space.id !== spaceId) throw new StorageError('corrupt_data', 'Stored space is invalid; original data was preserved');
    return parsed.data;
  }
  async function load(spaceId: string): Promise<SpaceState | null> {
    const row = await active.get<{state: string}>('SELECT state FROM spaces WHERE id = ?', [spaceId]);
    if (!row) return null;
    let value: unknown;
    try { value = JSON.parse(row.state); } catch { throw new StorageError('corrupt_data', 'Stored JSON is invalid; original data was preserved'); }
    return validate(value, spaceId);
  }
  return {
    initialize(ownerId, newSpaceId) {
      return serial(async () => {
        const candidateId = newSpaceId ?? `local:${ownerId}`;
        const initial = createSpaceState({id: candidateId, name: '个人空间'}, ownerId);
        await prepare();
        return atomic(async () => {
          const existing = await active.get<{id: string}>('SELECT id FROM spaces WHERE owner_id = ?', [ownerId]);
          if (existing) {
            if (!await load(existing.id)) throw new StorageError('corrupt_data', 'Owner space is missing');
            return {spaceId: existing.id, actorId: ownerId};
          }
          await active.run('INSERT INTO spaces (id, owner_id, state) VALUES (?, ?, ?)', [candidateId, ownerId, JSON.stringify(initial)]);
          return {spaceId: candidateId, actorId: ownerId};
        });
      });
    },
    transaction<T>(spaceId: string, work: (state: SpaceState) => Promise<T>) {
      return serial(async () => {
        await prepare();
        return atomic(async () => {
          const state = await load(spaceId);
          if (!state) throw new StorageError('space_not_found', 'Space does not exist');
          const result = await work(state);
          const validated = validate(state, spaceId);
          await active.run('UPDATE spaces SET state = ? WHERE id = ?', [JSON.stringify(validated), spaceId]);
          return result;
        });
      });
    },
    read<T>(spaceId: string, query: (state: SpaceState) => T) {
      return serial(async () => {
        await prepare();
        const state = await load(spaceId);
        if (!state) throw new StorageError('space_not_found', 'Space does not exist');
        return query(state);
      });
    },
    close() {
      if (closed) return Promise.resolve();
      return serial(async () => { await connection.close?.(); closed = true; });
    },
  };
}
