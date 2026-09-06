import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// Isolated adapter feasibility fixture; this is not the Siyue command handler.
const schemaVersion = 1;

function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > schemaVersion) throw new Error('unsupported_schema_version');
    if (version === 0) {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE objects (
            space_id TEXT NOT NULL,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            PRIMARY KEY (space_id, id)
          );
          CREATE TABLE events (
            space_id TEXT NOT NULL,
            command_id TEXT NOT NULL,
            object_id TEXT NOT NULL,
            PRIMARY KEY (space_id, command_id),
            FOREIGN KEY (space_id, object_id) REFERENCES objects (space_id, id)
          );
          CREATE TABLE receipts (
            space_id TEXT NOT NULL,
            command_id TEXT NOT NULL,
            parameters TEXT NOT NULL,
            object_id TEXT NOT NULL,
            PRIMARY KEY (space_id, command_id),
            FOREIGN KEY (space_id, object_id) REFERENCES objects (space_id, id)
          );
          PRAGMA user_version = 1;
        `);
      });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction(db, body) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Just three SQL writes to exercise atomicity and a composite unique key.
function writeFixture(db, { spaceId, commandId, objectId, title }, faultAt) {
  return transaction(db, () => {
    const parameters = JSON.stringify({ objectId, title });
    const previous = db.prepare(
      'SELECT parameters, object_id FROM receipts WHERE space_id = ? AND command_id = ?',
    ).get(spaceId, commandId);
    if (previous) {
      if (previous.parameters !== parameters) throw new Error('command_conflict');
      return previous.object_id;
    }
    db.prepare('INSERT INTO objects VALUES (?, ?, ?)').run(spaceId, objectId, title);
    if (faultAt === 'object') throw new Error('injected_write_failure');
    db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(spaceId, commandId, objectId);
    if (faultAt === 'event') throw new Error('injected_write_failure');
    db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)').run(spaceId, commandId, parameters, objectId);
    if (faultAt === 'receipt') throw new Error('injected_write_failure');
    return objectId;
  });
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'siyue-storage-poc-'));
  const handles = new Set();
  t.after(() => {
    for (const db of handles) db.close();
    rmSync(directory, { recursive: true });
  });
  return {
    filename: (account = 'account-a') => join(directory, `${account}.sqlite`),
    open(account = 'account-a') {
      const db = openDatabase(this.filename(account));
      handles.add(db);
      return db;
    },
    close(db) {
      db.close();
      handles.delete(db);
    },
  };
}

const command = { spaceId: 'space-a', commandId: 'command-1', objectId: 'object-1', title: 'Synthetic goal' };

function counts(db) {
  return ['objects', 'events', 'receipts'].map((table) =>
    db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total,
  );
}

test('runtime exposes SQLite and reports its actual version', (t) => {
  const f = fixture(t);
  const db = f.open();
  const version = db.prepare('SELECT sqlite_version() AS version').get().version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  t.diagnostic(JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, sqlite: version, platform: process.platform, arch: process.arch }));
});

test('file reopen preserves committed object, event, receipt and schema', (t) => {
  const f = fixture(t);
  const initial = f.open();
  assert.equal(writeFixture(initial, command), command.objectId);
  f.close(initial);
  const reopened = f.open();
  assert.deepEqual(counts(reopened), [1, 1, 1]);
  assert.equal(reopened.prepare('SELECT title FROM objects WHERE space_id = ? AND id = ?').get(command.spaceId, command.objectId).title, command.title);
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1);
});

for (const faultAt of ['object', 'event', 'receipt']) {
  test(`failure after ${faultAt} rolls back all writes, including after reopen`, (t) => {
    const f = fixture(t);
    const db = f.open();
    assert.throws(() => writeFixture(db, command, faultAt), /injected_write_failure/);
    assert.deepEqual(counts(db), [0, 0, 0]);
    f.close(db);
    assert.deepEqual(counts(f.open()), [0, 0, 0]);
  });
}

test('lost response retry returns existing receipt; changed parameters cannot replace it', (t) => {
  const f = fixture(t);
  const db = f.open();
  writeFixture(db, command); // Deliberately discard the response.
  f.close(db);
  const reopened = f.open();
  assert.equal(writeFixture(reopened, command), command.objectId);
  assert.throws(() => writeFixture(reopened, { ...command, title: 'Different request' }), /command_conflict/);
  assert.deepEqual(counts(reopened), [1, 1, 1]);
  assert.equal(reopened.prepare('SELECT title FROM objects').get().title, command.title);
});

test('second connection reports lock contention and retries once the lock is released', (t) => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  first.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => writeFixture(second, command), (error) => {
      assert.equal(error.errcode, 5); // SQLITE_BUSY
      return true;
    });
    assert.deepEqual(counts(second), [0, 0, 0]);
  } finally {
    first.exec('ROLLBACK');
  }
  assert.equal(writeFixture(second, command), command.objectId);
  assert.equal(writeFixture(first, command), command.objectId);
  assert.deepEqual(counts(first), [1, 1, 1]);
});

test('account files and space-scoped keys isolate records and command IDs', (t) => {
  const f = fixture(t);
  const accountA = f.open();
  const accountB = f.open('account-b');
  writeFixture(accountA, command);
  assert.deepEqual(counts(accountB), [0, 0, 0]);
  writeFixture(accountA, { ...command, spaceId: 'space-b', title: 'Space B goal' });
  writeFixture(accountB, { ...command, title: 'Account B goal' });
  assert.equal(accountA.prepare('SELECT title FROM objects WHERE space_id = ? AND id = ?').get('space-b', command.objectId).title, 'Space B goal');
  assert.equal(accountA.prepare('SELECT title FROM objects WHERE space_id = ? AND id = ?').get(command.spaceId, command.objectId).title, command.title);
  assert.equal(accountB.prepare('SELECT title FROM objects').get().title, 'Account B goal');
  assert.equal(accountA.prepare('SELECT count(*) AS total FROM receipts WHERE space_id = ?').get('space-b').total, 1);
});

test('composite foreign key rejects cross-space references without leaving partial data', (t) => {
  const f = fixture(t);
  const db = f.open();
  writeFixture(db, command);
  assert.throws(() => transaction(db, () => {
    db.prepare('INSERT INTO events VALUES (?, ?, ?)').run('space-b', 'cross-space-command', command.objectId);
  }), /FOREIGN KEY constraint failed/);
  assert.deepEqual(counts(db), [1, 1, 1]);
});

test('failed schema upgrade rolls back DDL, data and version, preserving original records', (t) => {
  const f = fixture(t);
  const db = f.open();
  writeFixture(db, command);
  assert.throws(() => transaction(db, () => {
    db.exec('ALTER TABLE objects ADD COLUMN summary TEXT; PRAGMA user_version = 2;');
    db.prepare('UPDATE objects SET title = ?').run('Uncommitted change');
    throw new Error('injected_migration_failure');
  }), /injected_migration_failure/);
  f.close(db);
  const reopened = f.open();
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(reopened.prepare('PRAGMA table_info(objects)').all().some((column) => column.name === 'summary'), false);
  assert.equal(reopened.prepare('SELECT title FROM objects').get().title, command.title);
  assert.deepEqual(counts(reopened), [1, 1, 1]);
});

test('opening a newer schema refuses access and leaves existing schema and data unchanged', (t) => {
  const f = fixture(t);
  const db = f.open();
  writeFixture(db, command);
  db.exec('PRAGMA user_version = 99; ALTER TABLE objects ADD COLUMN future_field TEXT;');
  f.close(db);
  assert.throws(() => f.open(), /unsupported_schema_version/);
  const inspection = new DatabaseSync(f.filename(), { readOnly: true });
  try {
    assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 99);
    assert.equal(inspection.prepare('PRAGMA table_info(objects)').all().some((column) => column.name === 'future_field'), true);
    assert.equal(inspection.prepare('SELECT title FROM objects').get().title, command.title);
    assert.deepEqual(counts(inspection), [1, 1, 1]);
  } finally {
    inspection.close();
  }
});
