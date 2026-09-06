import React, { useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import * as SQLite from 'expo-sqlite';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spaceStateSchema } from '@siyue/contracts';
import type { LocalClient } from '@siyue/adapters';
import HomeScreen from '../../app/index';
import { createNativeClient } from '../../src/native-client';

// This module is imported only by the independently bundled native QA entry.
const processSession = Crypto.randomUUID();
const clients = new Map<string, Promise<LocalClient>>();
const validCase = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function names(caseId: string) {
  check(validCase(caseId), 'Case ID must be a lowercase UUID v4');
  return {databaseName: `siyue-native-run-${caseId}.db`, pendingDatabaseName: `siyue-native-run-${caseId}-pending.db`};
}
function load(caseId: string) {
  const filenames = names(caseId);
  let promise = clients.get(caseId);
  if (!promise) {
    promise = createNativeClient({...filenames, mockDelayMs: 20_000, mockTimeoutMs: 30_000});
    clients.set(caseId, promise);
  }
  return promise;
}
async function observe(caseId: string, initialized: Promise<LocalClient>) {
  const filenames = names(caseId);
  // Wait for the existing screen's initialization. Never construct a second host
  // or recover a live run when the user opens the observation panel.
  await initialized;
  let database: SQLite.SQLiteDatabase | undefined;
  let pending: SQLite.SQLiteDatabase | undefined;
  try {
    database = await SQLite.openDatabaseAsync(filenames.databaseName, {useNewConnection: true});
    pending = await SQLite.openDatabaseAsync(filenames.pendingDatabaseName, {useNewConnection: true});
    const version = await database.getFirstAsync<{user_version: number}>('PRAGMA user_version');
    check(version?.user_version === 1, 'Unexpected QA space database version');
    const rows = await database.getAllAsync<{id: string; owner_id: string; state: string}>('SELECT id, owner_id, state FROM spaces ORDER BY id');
    check(rows.length === 1 && rows[0]!.owner_id === 'local-owner', 'Expected one isolated local QA space');
    const state = spaceStateSchema.parse(JSON.parse(rows[0]!.state));
    check(state.space.id === rows[0]!.id, 'Stored space ID does not match its row');
    const pendingVersion = await pending.getFirstAsync<{user_version: number}>('PRAGMA user_version');
    const objects = await pending.getAllAsync<{type: string; name: string}>('SELECT type, name FROM sqlite_master');
    let pendingCount = 0;
    if (pendingVersion?.user_version === 0) {
      check(objects.length === 0, 'Unversioned pending database contains existing objects');
    } else {
      check(pendingVersion?.user_version === 1 && objects.some((item) => item.type === 'table' && item.name === 'pending_requests'),
        'Pending database has an unsupported version or missing table');
      const row = await pending.getFirstAsync<{total: number}>('SELECT count(*) AS total FROM pending_requests');
      check(row && Number.isSafeInteger(row.total) && row.total >= 0, 'Invalid pending row count');
      pendingCount = row.total;
    }
    return {schemaVersion: 1, caseId, processSession, spaceId: state.space.id,
      counts: {goals: state.goals.length, projects: state.projects.length, tasks: state.tasks.length,
        events: state.events.length, receipts: state.receipts.length, drafts: state.drafts.length, approvals: state.approvals.length},
      runs: state.runs.map((run) => ({id: run.id, status: run.status, seq: run.seq, events: run.events,
        ...(run.draftId !== undefined ? {draftId: run.draftId} : {})})), pendingCount};
  } finally {
    try { await database?.closeAsync(); } finally { await pending?.closeAsync(); }
  }
}

export function NativeRunScreen({caseId}: {caseId: string}) {
  const initialized = useMemo(() => validCase(caseId) ? load(caseId) : undefined, [caseId]);
  const loadClient = useMemo(() => () => initialized ?? Promise.reject(new Error('Invalid QA case ID')), [initialized]);
  const [observing, setObserving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function read() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setObserving(true); setResult(''); setError('');
    try {
      check(initialized, 'Invalid QA case ID');
      setResult(JSON.stringify(await observe(caseId, initialized)));
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { locked.current = false; setBusy(false); }
  }
  if (!validCase(caseId)) return <SafeAreaView><Text testID="siyue-qa-run-error">Case ID must be a lowercase UUID v4</Text></SafeAreaView>;
  return <View style={styles.screen}>
    <SafeAreaView edges={['top']} style={styles.bar}>
      <Text testID="siyue-qa-run-ready" style={styles.label}>生成与中断 QA · 独立合成库 · 20 秒 Mock</Text>
      <View style={styles.buttons}>
        <Button testID="siyue-qa-run-observe" title="读取真实运行状态" disabled={busy} onPress={() => void read()} />
        <Button testID="siyue-qa-run-back" title="返回正常界面" onPress={() => setObserving(false)} />
      </View>
    </SafeAreaView>
    {/* Keep HomeScreen mounted: unmount cleanup aborts its active generation. */}
    <View style={[styles.screen, observing && styles.hidden]}><HomeScreen loadClient={loadClient} /></View>
    <ScrollView style={[styles.screen, !observing && styles.hidden]} contentContainerStyle={styles.observation}>
      <Text>仅读取独立 SQLite 连接；不会恢复、取消或重试正在运行的命令。</Text>
      {busy && <Text>正在读取</Text>}
      {!!error && <Text testID="siyue-qa-run-error" style={styles.error}>{error}</Text>}
      {!!result && <Text testID="siyue-qa-run-result" selectable style={styles.result}>{result}</Text>}
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({screen: {flex: 1}, hidden: {display: 'none'}, bar: {backgroundColor: '#fff0cc', paddingHorizontal: 8},
  label: {fontSize: 11, color: '#64410d'}, buttons: {flexDirection: 'row', justifyContent: 'space-between'},
  observation: {padding: 16, gap: 12}, result: {fontSize: 11, lineHeight: 15}, error: {color: '#a32920'}});
