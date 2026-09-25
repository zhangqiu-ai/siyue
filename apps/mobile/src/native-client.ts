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
  spaceId?: string;
  lifetimeSignal?: AbortSignal;
  pendingDatabaseName?: string;
  decorateService?: (service: CommandService) => CommandService;
  decorateJournalStorage?: (storage: AsyncKeyValueStore) => AsyncKeyValueStore;
  mockDelayMs?: number;
  mockTimeoutMs?: number;
  enableMock?: boolean;
}

/** Shared native host construction. Normal callers use the original databases and no decorators. */
export async function createNativeClient(options: NativeClientOptions = {}): Promise<LocalClient> {
  return (await createNativeClientResource(options)).client;
}

/** One workspace owns both connections. Retirement aborts calls, drains them, then closes. */
export async function createNativeClientResource(options: NativeClientOptions = {}): Promise<{client:LocalClient;close():Promise<void>}> {
  const databaseName = options.databaseName ?? 'siyue-m1.db';
  const pendingDatabaseName = options.pendingDatabaseName ?? 'siyue-m1-pending.db';
  if (![databaseName, pendingDatabaseName].every((name) => /^[a-zA-Z0-9._-]+\.db$/.test(name)) || databaseName === pendingDatabaseName) {
    throw new Error('Native storage requires distinct local database filenames');
  }
  if(options.spaceId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.spaceId))throw new Error('Invalid space identity');
  const lifetime=new AbortController();
  const abort=()=>lifetime.abort();
  if(options.lifetimeSignal?.aborted)throw Object.assign(new Error('cancelled'),{code:'cancelled'});
  options.lifetimeSignal?.addEventListener('abort',abort,{once:true});
  let database:SQLite.SQLiteDatabase;
  try{database=await SQLite.openDatabaseAsync(databaseName);}catch(error){options.lifetimeSignal?.removeEventListener('abort',abort);throw error;}
  const store = createSqliteStore(wrapNativeConnection(database));
  let requestStorage: ReturnType<typeof createSqliteRequestJournalStorage> | undefined;
  try {
    await database.execAsync('PRAGMA journal_mode = WAL;');
    const { spaceId, actorId } = await store.initialize('local-owner', options.spaceId??Crypto.randomUUID());
    if(options.spaceId&&spaceId!==options.spaceId)throw Object.assign(new Error('Workspace identity mismatch'),{code:'corrupt_data'});
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
    const executor = options.enableMock ? new MockAgentExecutor({ delayMs: options.mockDelayMs ?? 250 }) : undefined;
    const local=createLocalClient({
      lifetimeSignal:lifetime.signal,
      service: options.decorateService?.(service) ?? service, runService, spaceId, actor, now, newId: Crypto.randomUUID,
      requestJournal: {
        storage: options.decorateJournalStorage?.(requestStorage) ?? requestStorage,
        hash: (input) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input),
      },
      propose: (goal, signal) => {
        if (!executor) return Promise.reject(Object.assign(new Error('An explicit model provider is required'), {code: 'configuration_required'}));
        return executor.createGoalPlan(goal, {
        runId: Crypto.randomUUID(), spaceId, ...(signal ? { signal } : {}),
        ...(options.mockTimeoutMs !== undefined ? { timeoutMs: options.mockTimeoutMs } : {}),
        });
      },
    });
    const pending=new Set<Promise<unknown>>();
    const client=new Proxy(local,{get(target,key: keyof LocalClient){
      const method=target[key];
      if(typeof method!=='function')return method;
      return (...args:unknown[])=>{
        if(lifetime.signal.aborted)return Promise.reject(Object.assign(new Error('cancelled'),{code:'cancelled'}));
        const operation=Promise.resolve().then(()=>(method as (...input:unknown[])=>unknown)(...args));
        pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;
      };
    }});
    let closed=false,closing:Promise<void>|undefined;
    return {client,close(){
      if(closed)return Promise.resolve();
      if(closing)return closing;
      abort();options.lifetimeSignal?.removeEventListener('abort',abort);
      closing=(async()=>{await Promise.allSettled([...pending]);await requestStorage!.close();await store.close();closed=true;})().finally(()=>{closing=undefined;});
      return closing;
    }};
  } catch (error) {
    abort();options.lifetimeSignal?.removeEventListener('abort',abort);
    // Preserve the database for recovery. Never replace it with an empty or in-memory store.
    await Promise.allSettled([store.close(), requestStorage?.close()]);
    throw error;
  }
}
