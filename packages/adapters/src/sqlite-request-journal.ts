import type { AsyncKeyValueStore } from './request-journal.js';
import { StorageError, type SqlConnection } from './sqlite-store.js';

/** Dedicated journal database and connection; never share the SpaceStore file. */
export function createSqliteRequestJournalStorage(connection: SqlConnection): AsyncKeyValueStore & {close(): Promise<void>} {
  let pending: Promise<unknown> = Promise.resolve();
  let ready = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = pending.then(() => {
      if (closed) throw new StorageError('closed', 'Request journal is closed');
      return work();
    });
    pending = result.catch(() => undefined);
    return result;
  }
  function validateKey(key: string) {
    if (!/^siyue\.pending\.v1\.[a-f0-9]{64}$/.test(key)) throw new Error('Request journal key must contain an opaque digest');
  }
  async function prepare() {
    if (ready) return;
    await connection.transaction(async (tx) => {
      const version = await tx.get<{user_version: number}>('PRAGMA user_version', []);
      if (!version || version.user_version < 0 || version.user_version > 1) throw new StorageError('unsupported_schema', 'Request journal version is not supported');
      if (version.user_version === 0) {
        const count = await tx.get<{total: number}>("SELECT count(*) AS total FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'", []);
        if (!count || count.total !== 0) throw new StorageError('corrupt_data', 'Unversioned journal contains existing data');
        await tx.exec('CREATE TABLE pending_requests (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); PRAGMA user_version = 1;');
      }
      const table = await tx.get<{name: string}>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_requests'", []);
      if (!table) throw new StorageError('corrupt_data', 'Request journal table is missing; original database was preserved');
    });
    ready = true;
  }
  return {
    getItem(key) {
      return serial(async () => {
        validateKey(key); await prepare();
        const row = await connection.get<{value: string}>('SELECT value FROM pending_requests WHERE key = ?', [key]);
        if (row && typeof row.value !== 'string') throw new StorageError('corrupt_data', 'Request journal value is invalid');
        return row?.value ?? null;
      });
    },
    setItem(key, value) {
      return serial(async () => {
        validateKey(key); await prepare();
        await connection.transaction(async (tx) => {
          await tx.run('INSERT INTO pending_requests (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
        });
      });
    },
    removeItem(key) {
      return serial(async () => {
        validateKey(key); await prepare();
        await connection.transaction(async (tx) => {await tx.run('DELETE FROM pending_requests WHERE key = ?', [key]);});
      });
    },
    close() {
      closing ??= serial(async () => {await connection.close?.(); closed = true;});
      return closing;
    },
  };
}
