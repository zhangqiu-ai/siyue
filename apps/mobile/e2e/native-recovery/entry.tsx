import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { businessCommandSchema, commandReceiptSchema, spaceStateSchema, type BusinessCommand, type CommandReceipt, type GoalDraft } from '@siyue/contracts';
import { canonicalize } from '@siyue/domain';
import { createNativeClient } from '../../src/native-client';
import { runStorageFaults } from './storage-faults';
import { NativeRunScreen } from './run-screen';

// This is a separately bundled QA entry. The production router never imports it.
type Phase = 'injected' | 'recovered';
type PendingRow = {key: string; value: string};
type PendingIdentity = {schemaVersion: number; commandId: string; issuedAt: string};
type Fixture = {caseId: string; phase: string; command: BusinessCommand; receipt: CommandReceipt; stateDigest: string};
const processSession = Crypto.randomUUID();
const digest = (value: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  check(canonicalize(actual) === canonicalize(expected), message);
}
function payloadFor(caseId: string): GoalDraft {
  return {title: `NativeQA-${caseId}-goal`, rationale: 'Synthetic receipt recovery fixture',
    projectTitles: [`NativeQA-${caseId}-project`], taskTitles: [`NativeQA-${caseId}-task`]};
}
function parsePending(row: PendingRow, command?: BusinessCommand): PendingIdentity {
  check(/^siyue\.pending\.v1\.[a-f0-9]{64}$/.test(row.key), 'Pending key is not an opaque digest');
  const value: unknown = JSON.parse(row.value);
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Pending metadata is not an object');
  equal(Object.keys(value).sort(), ['commandId', 'issuedAt', 'schemaVersion'], 'Journal contains fields beyond opaque identity');
  const identity = value as PendingIdentity;
  check(identity.schemaVersion === 1 && typeof identity.commandId === 'string' && identity.commandId.length > 0 &&
    typeof identity.issuedAt === 'string' && Number.isFinite(Date.parse(identity.issuedAt)), 'Invalid pending identity');
  if (command) equal(identity, {schemaVersion: 1, commandId: command.commandId, issuedAt: command.issuedAt}, 'Journal/command identity mismatch');
  return identity;
}
async function pendingRows(database: SQLite.SQLiteDatabase): Promise<PendingRow[]> {
  const table = await database.getFirstAsync<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_requests'");
  return table ? database.getAllAsync<PendingRow>('SELECT key, value FROM pending_requests ORDER BY key') : [];
}
async function snapshot(database: SQLite.SQLiteDatabase, command?: BusinessCommand) {
  const rows = await database.getAllAsync<{state: string}>('SELECT state FROM spaces');
  check(rows.length === 1, 'Expected exactly one real SQLite space row');
  const state = spaceStateSchema.parse(JSON.parse(rows[0]!.state));
  const counts = {goals: state.goals.length, projects: state.projects.length, tasks: state.tasks.length,
    events: state.events.length, receipts: state.receipts.length};
  if (command) {
    equal(counts, {goals: 1, projects: 1, tasks: 1, events: 1, receipts: 1}, 'SQLite transaction did not persist exactly one of each record');
    check(command.kind === 'plan.create', 'Unexpected fixture command kind');
    equal([state.goals[0]!.title, state.projects[0]!.title, state.tasks[0]!.title],
      [command.payload.title, command.payload.projectTitles[0], command.payload.taskTitles[0]], 'SQLite object payload mismatch');
    check(state.events[0]!.commandId === command.commandId && state.receipts[0]!.commandId === command.commandId, 'SQLite event/receipt command mismatch');
    equal(state.events[0]!.entities, state.receipts[0]!.result.entities, 'SQLite event and receipt entities differ');
  }
  return {state, counts, stateDigest: await digest(canonicalize(state))};
}
async function runCase(caseId: string, phase: Phase) {
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(caseId), 'Case ID must be a fresh lowercase UUID v4');
  const prefix = `siyue-native-qa-${caseId}`;
  const databaseName = `${prefix}.db`;
  const pendingDatabaseName = `${prefix}-pending.db`;
  const metadata = await SQLite.openDatabaseAsync(`${prefix}-fixture.db`);
  // Only synthetic fixture metadata contains the full command. The request journal must not.
  await metadata.execAsync('CREATE TABLE IF NOT EXISTS fixture (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
  const prior = await metadata.getFirstAsync<{value: string}>('SELECT value FROM fixture WHERE id = ?', [caseId]);
  let fixture: Fixture | undefined;
  if (phase === 'injected') {
    check(!prior, 'Case already exists; use a new case ID. Existing data was preserved.');
    await metadata.runAsync('INSERT INTO fixture (id, value) VALUES (?, ?)', [caseId, JSON.stringify({caseId, phase: 'started'})]);
  } else {
    check(prior, 'No existing injected case. Re-enter the original case ID.');
    const value = JSON.parse(prior.value) as Partial<Fixture>;
    check(value.caseId === caseId && value.phase === 'injected' && typeof value.stateDigest === 'string', 'Fixture is incomplete or already recovered');
    fixture = {caseId, phase: 'injected', command: businessCommandSchema.parse(value.command),
      receipt: commandReceiptSchema.parse(value.receipt), stateDigest: value.stateDigest};
    check(fixture.command.kind === 'plan.create', 'Recovery requires the original plan command');
    equal(fixture.command.payload, payloadFor(caseId), 'Re-entered payload differs from the original command');
  }
  const database = await SQLite.openDatabaseAsync(databaseName, {useNewConnection: true});
  const pendingDatabase = await SQLite.openDatabaseAsync(pendingDatabaseName, {useNewConnection: true});
  let executeCalls = 0;
  let receiptCalls = 0;
  let cleanupCalls = 0;
  let journalBeforeExecute = false;
  let journalBeforeReceipt = false;
  let receiptValidated = false;
  let metadataOnly = false;
  let pendingIdentity: PendingIdentity | undefined;
  let cleanupAfterReceiptValidation = false;
  const trace: string[] = [];
  try {
    const client = await createNativeClient({databaseName, pendingDatabaseName,
      decorateService: (service) => ({...service,
        async execute(input, actor) {
          executeCalls += 1;
          check(phase === 'injected', 'Recovery attempted to execute again');
          const command = businessCommandSchema.parse(input);
          check(command.kind === 'plan.create', 'Unexpected command');
          equal(command.payload, payloadFor(caseId), 'Injected command must use the synthetic payload');
          const before = await pendingRows(pendingDatabase);
          check(before.length === 1, 'Identity was not durably journaled before execute');
          pendingIdentity = parsePending(before[0]!, command);
          metadataOnly = true;
          journalBeforeExecute = true;
          trace.push('journal_present_before_execute');
          await metadata.runAsync('UPDATE fixture SET value = ? WHERE id = ?', [JSON.stringify({caseId, phase: 'executing', command}), caseId]);
          const receipt = await service.execute(command, actor);
          const persisted = await snapshot(database, command);
          equal(persisted.state.receipts[0], receipt, 'Returned receipt was not durably committed');
          fixture = {caseId, phase: 'injected', command, receipt, stateDigest: persisted.stateDigest};
          await metadata.runAsync('UPDATE fixture SET value = ? WHERE id = ?', [JSON.stringify(fixture), caseId]);
          trace.push('sqlite_commit_observed', 'response_lost');
          throw new Error('QA_RESPONSE_LOST');
        },
        async getReceipt(spaceId, actor, commandId) {
          receiptCalls += 1;
          const rows = await pendingRows(pendingDatabase);
          check(rows.length === 1, 'Pending identity disappeared before receipt lookup');
          check(fixture, 'Original fixture not saved');
          pendingIdentity = parsePending(rows[0]!, fixture.command);
          metadataOnly = true;
          journalBeforeReceipt = true;
          trace.push('journal_present_before_receipt');
          if (phase === 'injected') {
            trace.push('receipt_temporarily_unavailable');
            throw new Error('QA_RECEIPT_UNAVAILABLE');
          }
          check(commandId === fixture.command.commandId && spaceId === fixture.command.spaceId, 'Recovery did not request the original receipt');
          const receipt = commandReceiptSchema.parse(await service.getReceipt(spaceId, actor, commandId));
          equal(receipt, fixture.receipt, 'Recovered receipt differs from original committed receipt');
          check(receipt.actorId === actor.id && receipt.actorKind === actor.kind &&
            receipt.payloadHash === await digest(canonicalize(fixture.command)), 'Receipt identity or payload validation failed');
          receiptValidated = true;
          trace.push('original_receipt_validated');
          return receipt;
        },
      }),
      decorateJournalStorage: (storage) => ({
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
        async removeItem(key) {
          cleanupCalls += 1;
          check(phase === 'recovered' && receiptValidated, 'Pending cleared before an original receipt was validated');
          const rows = await pendingRows(pendingDatabase);
          check(rows.length === 1 && rows[0]!.key === key && fixture, 'Pending identity changed before clearing');
          parsePending(rows[0]!, fixture.command);
          trace.push('journal_present_until_validated');
          await storage.removeItem(key);
          check((await pendingRows(pendingDatabase)).length === 0, 'Real journal storage did not clear reconciled identity');
          cleanupAfterReceiptValidation = true;
          trace.push('journal_cleared');
        },
      }),
    });
    if (phase === 'injected') {
      const initial = await snapshot(database);
      equal(initial.counts, {goals: 0, projects: 0, tasks: 0, events: 0, receipts: 0}, 'Case database already has formal data');
      check((await pendingRows(pendingDatabase)).length === 0, 'Case journal already exists');
      let failure: unknown;
      try { await client.saveManual(payloadFor(caseId)); } catch (error) { failure = error; }
      check(failure instanceof Error && failure.message === 'QA_RESPONSE_LOST', 'Client did not preserve the unknown response outcome');
      check(executeCalls === 1 && receiptCalls === 1 && cleanupCalls === 0 && journalBeforeExecute, 'Injection did not exercise the expected real command/journal flow');
    } else {
      check(fixture, 'Original fixture missing');
      const before = await snapshot(database, fixture.command);
      equal(before.stateDigest, fixture.stateDigest, 'Data changed while the app process was stopped');
      const receipt = await client.saveManual(payloadFor(caseId));
      equal(receipt, fixture.receipt, 'Client recovery did not return the original receipt');
      check(executeCalls === 0 && receiptCalls === 1 && cleanupCalls === 1 && receiptValidated && cleanupAfterReceiptValidation, 'Recovery did not use receipt-only reconciliation');
    }
    check(fixture && pendingIdentity && metadataOnly && journalBeforeReceipt, 'Missing native observation evidence');
    const savedMetadata = await metadata.getFirstAsync<{value: string}>('SELECT value FROM fixture WHERE id = ?', [caseId]);
    check(savedMetadata, 'Original command fixture was not durably saved');
    const savedFixture = JSON.parse(savedMetadata.value) as Partial<Fixture>;
    equal(businessCommandSchema.parse(savedFixture.command), fixture.command, 'Persisted fixture command does not match original identity and payload');
    equal(commandReceiptSchema.parse(savedFixture.receipt), fixture.receipt, 'Persisted fixture receipt differs');
    const persisted = await snapshot(database, fixture.command);
    equal(persisted.stateDigest, fixture.stateDigest, 'Reconciliation changed the formal SQLite snapshot');
    const pending = await pendingRows(pendingDatabase);
    check(pending.length === (phase === 'injected' ? 1 : 0), 'Unexpected final pending count');
    if (pending.length) parsePending(pending[0]!, fixture.command);
    const entities = persisted.state.receipts[0]!.result.entities;
    for (const kind of ['goal', 'project', 'task'] as const) check(entities.filter((item) => item.kind === kind).length === 1, 'Receipt entity is not unique');
    const result = {schemaVersion: 1, caseId, phase, processSession,
      commandId: fixture.command.commandId, issuedAt: fixture.command.issuedAt, spaceId: fixture.command.spaceId,
      goalId: persisted.state.goals[0]!.id, projectId: persisted.state.projects[0]!.id, taskId: persisted.state.tasks[0]!.id,
      counts: persisted.counts, stateDigest: persisted.stateDigest, metadataPersisted: true, executeCalls, receiptCalls, cleanupCalls,
      journal: {metadataOnly, beforeExecute: journalBeforeExecute, beforeReceipt: journalBeforeReceipt,
        commandId: pendingIdentity.commandId, issuedAt: pendingIdentity.issuedAt, pendingCount: pending.length,
        cleanupAfterReceiptValidation}, receiptValidated, trace};
    if (phase === 'recovered') await metadata.runAsync('UPDATE fixture SET value = ? WHERE id = ?', [JSON.stringify({...fixture, phase: 'recovered'}), caseId]);
    return result;
  } finally {
    // Close observer connections only. The normal native client owns its real store/journal until process termination.
    await Promise.allSettled([database.closeAsync(), pendingDatabase.closeAsync(), metadata.closeAsync()]);
  }
}

function NativeRecoveryScreen() {
  const [runScreenCase, setRunScreenCase] = useState('');
  const [caseId, setCaseId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  async function run(phase: Phase | 'storage') {
    setBusy(true); setError(''); setResult('');
    try { setResult(JSON.stringify(await (phase === 'storage' ? runStorageFaults(caseId.trim()) : runCase(caseId.trim(), phase)))); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  if (runScreenCase) return <NativeRunScreen caseId={runScreenCase} />;
  return <SafeAreaView style={styles.safe}><ScrollView testID="siyue-qa-scroll" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text testID="siyue-qa-ready" style={styles.title}>Expo SQLite 丢回执 QA</Text>
    <Text>独立合成数据库。重新启动后需手动输入同一个 case ID；不会自动恢复表单。</Text>
    <TextInput testID="siyue-qa-case" accessibilityLabel="QA case ID" value={caseId} onChangeText={setCaseId} editable={!busy} autoCapitalize="none" autoCorrect={false} style={styles.input} />
    <View style={styles.buttons}><Button testID="siyue-qa-inject" title="注入丢回执" disabled={busy} onPress={() => void run('injected')} />
      <Button testID="siyue-qa-recover" title="恢复原命令" disabled={busy} onPress={() => void run('recovered')} />
      <Button testID="siyue-qa-storage" title="验证存储故障" disabled={busy} onPress={() => void run('storage')} />
      <Button testID="siyue-qa-run-ui" title="正常界面生成验收" disabled={busy} onPress={() => {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(caseId.trim())) setRunScreenCase(caseId.trim());
        else setError('Case ID must be a lowercase UUID v4');
      }} /></View>
    <Text testID="siyue-qa-status">{busy ? '正在执行真实 SQLite 验证' : result ? '阶段验证完成，结果如下' : '等待明确选择阶段'}</Text>
    {error ? <Text testID="siyue-qa-error" style={styles.error}>{error}</Text> : null}
    {result ? <Text testID="siyue-qa-result" selectable style={styles.result}>{result}</Text> : null}
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({safe: {flex: 1, backgroundColor: '#f8f6f0'}, content: {padding: 20, gap: 14},
  title: {fontSize: 22, fontWeight: '600'}, input: {borderWidth: 1, borderColor: '#8d958c', padding: 12, borderRadius: 8},
  buttons: {gap: 10}, result: {fontSize: 11, lineHeight: 15}, error: {color: '#a32920'}});
function App() { return <SafeAreaProvider><NativeRecoveryScreen /></SafeAreaProvider>; }
registerRootComponent(App);
