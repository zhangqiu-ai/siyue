import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { createCommandService, createRunService, type CommandService } from '@siyue/domain';
import { MockAgentExecutor } from '@siyue/ai';
import { createLocalClient, createSqliteRequestJournalStorage, createSqliteStore, type LocalClient, type SqlConnection, type AsyncKeyValueStore } from '@siyue/adapters';

/** The native connection belongs exclusively to this adapter, never to a screen. */
export function wrapNativeConnection(database: SQLite.SQLiteDatabase, insideTransaction = false): SqlConnection {
  return {
    async exec(sql) { await database.execAsync(sql); },
    async get<T>(sql: string, params: readonly (string | number | null)[]) {
      return database.getFirstAsync<T>(sql, [...params]);
    },
    async run(sql, params) { await database.runAsync(sql, [...params]); },
    async transaction<T>(work: (transaction: SqlConnection) => Promise<T>): Promise<T> {
      if (insideTransaction) throw new Error('Nested transactions are not supported');
      let result: { value: T } | undefined;
      await database.withExclusiveTransactionAsync(async (transaction) => {
        result = { value: await work(wrapNativeConnection(transaction, true)) };
      });
      if (!result) throw new Error('Transaction did not complete');
      return result.value;
    },
    ...(!insideTransaction ? { close: () => database.closeAsync() } : {}),
  };
}

export interface NativeClientOptions {
  databaseName?: string;
  pendingDatabaseName?: string;
  decorateService?: (service: CommandService) => CommandService;
  decorateJournalStorage?: (storage: AsyncKeyValueStore) => AsyncKeyValueStore;
  mockDelayMs?: number;
  mockTimeoutMs?: number;
}

/** Shared native host construction. Normal callers use the original databases and no decorators. */
export async function createNativeClient(options: NativeClientOptions = {}): Promise<LocalClient> {
  const databaseName = options.databaseName ?? 'siyue-m1.db';
  const pendingDatabaseName = options.pendingDatabaseName ?? 'siyue-m1-pending.db';
  if (![databaseName, pendingDatabaseName].every((name) => /^[a-zA-Z0-9._-]+\.db$/.test(name)) || databaseName === pendingDatabaseName) {
    throw new Error('Native storage requires distinct local database filenames');
  }
  const database = await SQLite.openDatabaseAsync(databaseName);
  const store = createSqliteStore(wrapNativeConnection(database));
  let requestStorage: ReturnType<typeof createSqliteRequestJournalStorage> | undefined;
  try {
    await database.execAsync('PRAGMA journal_mode = WAL;');
    const { spaceId, actorId } = await store.initialize('local-owner', Crypto.randomUUID());
    const now = () => new Date().toISOString();
    const service = createCommandService({
      store, now, newId: Crypto.randomUUID,
      hash: (input) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input),
    });
    const actor = { id: actorId, kind: 'user' as const };
    const runService = createRunService({ store, now, newId: Crypto.randomUUID });
    await runService.recover(spaceId, actor);
    // Separate journal: persist command identity before the business transaction.
    // After an interrupted response, the formal receipt decides whether to retry.
    const pendingDatabase = await SQLite.openDatabaseAsync(pendingDatabaseName);
    requestStorage = createSqliteRequestJournalStorage(wrapNativeConnection(pendingDatabase));
    const executor = new MockAgentExecutor({ delayMs: options.mockDelayMs ?? 250 });
    return createLocalClient({
      service: options.decorateService?.(service) ?? service, runService, spaceId, actor, now, newId: Crypto.randomUUID,
      requestJournal: {
        storage: options.decorateJournalStorage?.(requestStorage) ?? requestStorage,
        hash: (input) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input),
      },
      propose: (goal, signal) => executor.createGoalPlan(goal, {
        runId: Crypto.randomUUID(), spaceId, ...(signal ? { signal } : {}),
        ...(options.mockTimeoutMs !== undefined ? { timeoutMs: options.mockTimeoutMs } : {}),
      }),
    });
  } catch (error) {
    // Preserve the database for recovery. Never replace it with an empty or in-memory store.
    await Promise.allSettled([store.close(), requestStorage?.close()]);
    throw error;
  }
}
