import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { spaceStateSchema, type BusinessCommand } from '@siyue/contracts';
import { canonicalize, createCommandService } from '@siyue/domain';
import { createSqliteStore, type SqlConnection } from '@siyue/adapters';
import { createNativeClient, wrapNativeConnection } from '../../src/native-client';

// Only the separately bundled QA entry imports this module. All fixtures are retained.
type Counts = {goals: number; projects: number; tasks: number; events: number; receipts: number};
type SpaceRow = {id: string; owner_id: string; state: string};
type RawSnapshot = {
  schema: {type: string; name: string; tbl_name: string; rootpage: number; sql: string | null}[];
  version: number;
  spaces: SpaceRow[];
  preserved: {value: string}[];
};
const hash = (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
const now = () => new Date().toISOString();
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message: string) {
  check(canonicalize(actual) === canonicalize(expected), message);
}
function counts(raw: RawSnapshot): Counts {
  check(raw.spaces.length === 1, 'Expected exactly one synthetic space');
  const state = spaceStateSchema.parse(JSON.parse(raw.spaces[0]!.state));
  return {goals: state.goals.length, projects: state.projects.length, tasks: state.tasks.length,
    events: state.events.length, receipts: state.receipts.length};
}
const each = (count: number): Counts => ({goals: count, projects: count, tasks: count, events: count, receipts: count});
async function rawSnapshot(database: SQLite.SQLiteDatabase): Promise<RawSnapshot> {
  const schema = await database.getAllAsync<RawSnapshot['schema'][number]>(
    'SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master ORDER BY type, name');
  const version = await database.getFirstAsync<{user_version: number}>('PRAGMA user_version');
  check(version, 'SQLite did not return user_version');
  return {schema, version: version.user_version,
    spaces: schema.some((item) => item.type === 'table' && item.name === 'spaces')
      ? await database.getAllAsync<SpaceRow>('SELECT id, owner_id, state FROM spaces ORDER BY id') : [],
    preserved: schema.some((item) => item.type === 'table' && item.name === 'preserved')
      ? await database.getAllAsync<{value: string}>('SELECT value FROM preserved ORDER BY value') : []};
}
async function inspect(databaseName: string) {
  const database = await SQLite.openDatabaseAsync(databaseName, {useNewConnection: true});
  try { return await rawSnapshot(database); } finally { await database.closeAsync(); }
}
async function fresh(databaseName: string) {
  const database = await SQLite.openDatabaseAsync(databaseName, {useNewConnection: true});
  try {
    const objects = await database.getFirstAsync<{total: number}>('SELECT count(*) AS total FROM sqlite_master');
    const version = await database.getFirstAsync<{user_version: number}>('PRAGMA user_version');
    check(objects?.total === 0 && version?.user_version === 0, 'Fixture database is not fresh; existing data was preserved');
    await database.execAsync('PRAGMA journal_mode = WAL;');
    return database;
  } catch (error) { await database.closeAsync(); throw error; }
}
function command(spaceId: string, title: string): BusinessCommand {
  return {schemaVersion: 1, commandId: Crypto.randomUUID(), issuedAt: now(), spaceId,
    kind: 'plan.create', payload: {title, rationale: 'Synthetic native storage fault fixture',
      projectTitles: [`${title}-project`], taskTitles: [`${title}-task`]}};
}
const makeService = (store: ReturnType<typeof createSqliteStore>) => createCommandService({store, now, newId: Crypto.randomUUID, hash});

async function rollbackCase(databaseName: string) {
  const database = await fresh(databaseName);
  const connection = wrapNativeConnection(database);
  let observer: SQLite.SQLiteDatabase | undefined;
  let armed = false;
  let insideCounts: Counts | undefined;
  let baseline: RawSnapshot | undefined;
  let insideWriteObserved = false;
  let observerSawBaseline = false;
  // Decorate the callback transaction, never the outer connection's run method.
  const decorate = (source: SqlConnection): SqlConnection => ({...source,
    transaction: (work) => source.transaction((tx) => work(decorate(tx))),
    async run(sql, params) {
      await source.run(sql, params);
      if (armed && sql.startsWith('UPDATE spaces SET state')) {
        armed = false;
        const row = await source.get<{state: string}>('SELECT state FROM spaces WHERE id = ?', [params[1]!]);
        check(row && baseline && observer, 'Missing transaction observation fixtures');
        const state = spaceStateSchema.parse(JSON.parse(row.state));
        insideCounts = {goals: state.goals.length, projects: state.projects.length, tasks: state.tasks.length,
          events: state.events.length, receipts: state.receipts.length};
        equal(insideCounts, each(2), 'Real SQL UPDATE was not visible inside its transaction');
        check(row.state !== baseline.spaces[0]!.state, 'Transaction did not change the stored JSON');
        insideWriteObserved = true;
        equal(await rawSnapshot(observer), baseline, 'Independent connection observed uncommitted data');
        observerSawBaseline = true;
        throw new Error('QA_AFTER_SQL_UPDATE');
      }
    },
  });
  const store = createSqliteStore(decorate(connection));
  let closed = false;
  try {
    const {spaceId, actorId} = await store.initialize('local-owner', Crypto.randomUUID());
    const actor = {id: actorId, kind: 'user' as const};
    const service = makeService(store);
    await service.execute(command(spaceId, 'Native-storage-baseline'), actor);
    observer = await SQLite.openDatabaseAsync(databaseName, {useNewConnection: true});
    baseline = await rawSnapshot(observer);
    const baselineCounts = counts(baseline);
    equal(baselineCounts, each(1), 'Baseline command must persist one of every record');
    const second = command(spaceId, 'Native-storage-retry');
    armed = true;
    let injected = false;
    try { await service.execute(second, actor); }
    catch (error) { check(error instanceof Error && error.message === 'QA_AFTER_SQL_UPDATE', 'Unexpected rollback error'); injected = true; }
    check(injected && insideWriteObserved && observerSawBaseline && insideCounts, 'SQL fault was not reached');
    const afterRollback = await rawSnapshot(observer);
    equal(afterRollback, baseline, 'Rollback changed baseline schema or raw rows');
    await store.close(); closed = true;
    await observer.closeAsync(); observer = undefined;
    const afterReopen = await inspect(databaseName);
    equal(afterReopen, baseline, 'Reopened database differs after rollback');

    const retryDatabase = await SQLite.openDatabaseAsync(databaseName, {useNewConnection: true});
    const retryStore = createSqliteStore(wrapNativeConnection(retryDatabase));
    let afterRetry: RawSnapshot;
    let afterDuplicate: RawSnapshot;
    try {
      const identity = await retryStore.initialize('local-owner', Crypto.randomUUID());
      check(identity.spaceId === spaceId, 'Retry changed the original space');
      const retryService = makeService(retryStore);
      const receipt = await retryService.execute(second, actor);
      afterRetry = await inspect(databaseName);
      equal(counts(afterRetry), each(2), 'Retry did not commit exactly one additional command');
      const state = spaceStateSchema.parse(JSON.parse(afterRetry.spaces[0]!.state));
      equal(state.receipts.find((item) => item.commandId === second.commandId), receipt, 'Returned receipt differs from persisted receipt');
      check(state.events.filter((item) => item.commandId === second.commandId).length === 1, 'Retry event is missing or duplicated');
      equal(state.events.find((item) => item.commandId === second.commandId)!.entities, receipt.result.entities, 'Event and receipt point to different entities');
      const repeated = await retryService.execute(second, actor);
      equal(repeated, receipt, 'Duplicate command returned a different receipt');
      afterDuplicate = await inspect(databaseName);
      equal(afterDuplicate, afterRetry, 'Duplicate command changed persisted data');
    } finally { await retryStore.close(); }
    return {databaseName, commandId: second.commandId, baselineCounts, insideCounts,
      afterRollbackCounts: counts(afterRollback), afterReopenCounts: counts(afterReopen),
      afterRetryCounts: counts(afterRetry), afterDuplicateCounts: counts(afterDuplicate),
      insideWriteObserved, observerSawBaseline, rollbackRawEqual: true, reopenRawEqual: true, retryReceiptEqual: true,
      baselineDigest: await hash(canonicalize(baseline)), rollbackDigest: await hash(canonicalize(afterRollback)),
      reopenDigest: await hash(canonicalize(afterReopen)), finalDigest: await hash(canonicalize(afterDuplicate))};
  } finally {
    try { if (!closed) await store.close(); } finally { await observer?.closeAsync(); }
  }
}

async function refusalCase(databaseName: string, kind: 'corrupt' | 'future') {
  const database = await fresh(databaseName);
  const store = createSqliteStore(wrapNativeConnection(database));
  let spaceId: string;
  try {
    const identity = await store.initialize('local-owner', Crypto.randomUUID());
    spaceId = identity.spaceId;
    await makeService(store).execute(command(spaceId, `Native-storage-${kind}`), {id: identity.actorId, kind: 'user'});
  } finally { await store.close(); }
  const fixture = await SQLite.openDatabaseAsync(databaseName, {useNewConnection: true});
  let before: RawSnapshot;
  try {
    if (kind === 'corrupt') await fixture.runAsync('UPDATE spaces SET state = ? WHERE id = ?', ['{QA_BROKEN_JSON', spaceId]);
    else await fixture.execAsync("CREATE TABLE preserved(value TEXT NOT NULL); INSERT INTO preserved VALUES ('QA_KEEP_ORIGINAL'); PRAGMA user_version = 99;");
    before = await rawSnapshot(fixture);
    if (kind === 'corrupt') check(before.spaces[0]?.state === '{QA_BROKEN_JSON', 'Corrupt fixture was not written');
    else { check(before.version === 99, 'Future version was not written'); equal(before.preserved, [{value: 'QA_KEEP_ORIGINAL'}], 'Sentinel missing'); }
  } finally { await fixture.closeAsync(); }
  const errorCode = kind === 'corrupt' ? 'corrupt_data' : 'unsupported_schema';
  let refused = false;
  try {
    await createNativeClient({databaseName, pendingDatabaseName: databaseName.replace(/\.db$/, '-pending.db')});
  } catch (error) {
    check(error !== null && typeof error === 'object' && 'code' in error && error.code === errorCode, 'Native factory returned an unexpected storage error');
    refused = true;
  }
  check(refused, 'Native factory accepted an invalid database');
  const after = await inspect(databaseName);
  equal(after, before, 'Refusal modified raw data, schema or version');
  const reopened = await inspect(databaseName);
  equal(reopened, before, 'Reopened invalid database was not preserved');
  return {databaseName, errorCode, beforeDigest: await hash(canonicalize(before)), afterDigest: await hash(canonicalize(after)),
    reopenDigest: await hash(canonicalize(reopened)), rawPreserved: true};
}

export async function runStorageFaults(caseId: string) {
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(caseId), 'Case ID must be a lowercase UUID v4');
  const name = (kind: string) => `siyue-native-storage-${caseId}-${kind}-${Crypto.randomUUID()}.db`;
  const rollback = await rollbackCase(name('rollback'));
  const corrupt = await refusalCase(name('corrupt'), 'corrupt');
  const future = await refusalCase(name('future'), 'future');
  return {schemaVersion: 1, caseId, phase: 'storage', kind: 'storage-faults', status: 'passed', cases: {rollback, corrupt, future}};
}
