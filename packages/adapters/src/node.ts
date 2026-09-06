import { DatabaseSync } from 'node:sqlite';
import { createSqliteStore, type SqlConnection } from './sqlite-store.js';

/** Node/Electron host only. Never export this driver from the platform-neutral entry. */
export function openNodeConnection(filename: string): SqlConnection {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout = 0');
  const connection: SqlConnection = {
    async exec(sql) { db.exec(sql); },
    async get<T>(sql: string, params: readonly (string | number | null)[]) { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    async run(sql, params) { db.prepare(sql).run(...params); },
    async transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(connection);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      }
    },
    async close() { db.close(); },
  };
  return connection;
}
export function openNodeStore(filename: string) { return createSqliteStore(openNodeConnection(filename)); }
