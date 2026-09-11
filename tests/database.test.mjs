import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../server/database.mjs';

const entry = (overrides = {}) => ({ id: 'entry-1', occurredAt: '2026-09-11T12:00:00-07:00', liquidsMl: 250, position: 'sitting', diaperNumber: 1, wettingsCount: 0, probability: 50, result: 'pee', source: 'random', edited: false, ...overrides });
const change = (overrides = {}) => ({ id: 'entry-1', mutationId: 'create-1', baseVersion: 0, entry: entry(), ...overrides });

test('central records and idempotency receipts survive reopening the SQLite file', async () => {
  await mkdir('artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/database-'));
  const file = resolve(directory, 'test.sqlite');
  let db = openDatabase(file);
  const person = db.ensureParticipant('https://auth.lidoll.dev', 'subject-one', 'Person');
  assert.equal(db.sync(person.id, [change()]).records.length, 1);
  db.close();
  db = openDatabase(file);
  assert.equal(db.ensureParticipant('https://auth.lidoll.dev', 'subject-one', 'Renamed').id, person.id);
  const retry = db.sync(person.id, [change()]);
  assert.deepEqual(retry.ack, ['create-1']);
  assert.equal(retry.records[0].version, 1);
  const rows = db.exportRows();
  assert.equal(rows[0].participant_id, person.id);
  assert.equal(rows[0].liquids_ml, 250);
  assert.equal('subject' in rows[0], false);
  await db.backup(resolve(directory, 'backup.sqlite'));
  const backup = openDatabase(resolve(directory, 'backup.sqlite'));
  assert.equal(backup.records(person.id).length, 1);
  backup.close();
  db.close();
});
test('participants cannot read or overwrite each other even when entry IDs match', () => {
  const db = openDatabase(':memory:');
  try {
    const alice = db.ensureParticipant('issuer', 'alice', 'Alice'), bob = db.ensureParticipant('issuer', 'bob', 'Bob');
    db.sync(alice.id, [change()]);
    assert.equal(db.records(bob.id).length, 0);
    db.sync(bob.id, [change({ entry: entry({ liquidsMl: 900 }) })]);
    assert.equal(db.records(alice.id)[0].entry.liquidsMl, 250);
    assert.equal(db.records(bob.id)[0].entry.liquidsMl, 900);
  } finally { db.close(); }
});
test('stale edits conflict, later edits in the same batch cannot bypass conflicts, and deletion leaves only a tombstone', () => {
  const db = openDatabase(':memory:');
  try {
    const person = db.ensureParticipant('issuer', 'alice', 'Alice');
    db.sync(person.id, [change()]);
    const conflict = db.sync(person.id, [change({ mutationId: 'stale', entry: entry({ liquidsMl: 800 }) }), change({ mutationId: 'later', baseVersion: 1, entry: entry({ liquidsMl: 999 }) })]);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.ack.length, 0);
    assert.equal(conflict.records[0].entry.liquidsMl, 250);
    db.sync(person.id, [change({ mutationId: 'delete', baseVersion: 1, entry: null })]);
    assert.equal(db.records(person.id)[0].entry, null);
    assert.equal(db.exportRows().length, 0);
    assert.equal(db.sync(person.id, [change({ mutationId: 'stale-create' })]).conflicts.length, 1);
    const missing = db.sync(person.id, [change({ id: 'missing', mutationId: 'missing', baseVersion: 2, entry: entry({ id: 'missing' }) })]);
    assert.equal(missing.conflicts[0].version, 0);
  } finally { db.close(); }
});
test('invalid batches and reused mutation IDs never partially commit', () => {
  const db = openDatabase(':memory:');
  try {
    const person = db.ensureParticipant('issuer', 'alice', 'Alice');
    assert.throws(() => db.sync(person.id, [change(), change({ id: 'bad', mutationId: 'bad', entry: entry({ id: 'bad', probability: 1.5 }) })]));
    assert.equal(db.records(person.id).length, 0);
    db.sync(person.id, [change()]);
    assert.throws(() => db.sync(person.id, [change({ mutationId: 'new', id: 'new', entry: entry({ id: 'new' }) }), change({ entry: entry({ liquidsMl: 800 }) })]), /reused/);
    assert.equal(db.records(person.id).length, 1);
  } finally { db.close(); }
});
test('app sessions are revocable and authorization attempts can be consumed only once', () => {
  const db = openDatabase(':memory:');
  try {
    const person = db.ensureParticipant('issuer', 'alice', 'Alice');
    const token = db.createSession(person.id);
    assert.equal(db.session(token).participant.id, person.id);
    assert.equal(db.session('bad'), null);
    db.deleteSession(token);
    assert.equal(db.session(token), null);
    db.saveLogin('test-attempt', { state: 'state', verifier: 'verifier' });
    assert.equal(db.takeLogin('test-attempt').state, 'state');
    assert.equal(db.takeLogin('test-attempt'), null);
  } finally { db.close(); }
});
