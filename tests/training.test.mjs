import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEntry, emptyState, validateState, dailySeries, toCsv } from '../lib/model.js';
import { trainingState, cooldownRemaining, instantTimestamp, protocolFor } from '../lib/training.js';
import { openDatabase } from '../server/database.mjs';
import { deviceState, connectAccount, reconcile } from '../lib/sync.js';

const protocol = (overrides = {}) => ({ id: 'enrollment', kind: 'protocol', occurredAt: '2026-09-01T12:00:00+00:00', protocolVersion: 1, timeZone: 'UTC', ...overrides });
const wetting = (id, day, category) => ({ id, kind: 'wetting', occurredAt: `2026-09-${day}T13:00:00+00:00`, category, position: 'sitting', diaperNumber: 1, edited: false });
const roll = (overrides = {}) => ({ id: 'roll', occurredAt: '2026-09-01T12:00:00+00:00', liquidsMl: 250, position: 'sitting', diaperNumber: 1, wettingsCount: 8, probability: 50, result: 'hold', source: 'random', edited: false, ...overrides });

test('ties decrease, predominance of SI/I increases, and empty completed days increase', () => {
  const entries = [protocol(), wetting('f', '01', 'forced'), wetting('i', '01', 'involuntary'), wetting('si', '02', 'semi-involuntary')];
  const view = trainingState(entries, new Date('2026-09-04T00:00:00Z'));
  assert.deepEqual(view.days.map(day => day.probability), [45, 50, 55]);
  assert.deepEqual(trainingState(entries, new Date('2026-09-04T00:00:00Z')), view, 'Reloading does not apply adjustments twice');
  assert.equal(trainingState([...entries, wetting('today', '04', 'forced')], new Date('2026-09-04T14:00:00Z')).probability, 55);
});

test('clamps on each day, then moves away from either bound on the next opposite result', () => {
  const events = Array.from({ length: 10 }, (_, index) => wetting(`v${index}`, String(index + 1).padStart(2, '0'), 'voluntary'));
  assert.equal(trainingState([protocol(), ...events], new Date('2026-09-11T00:00:00Z')).probability, 20);
  assert.equal(trainingState([protocol(), ...events], new Date('2026-09-12T00:00:00Z')).probability, 25);
  assert.equal(trainingState([protocol(), wetting('f', '10', 'forced')], new Date('2026-09-11T00:00:00Z')).probability, 75);
});

test('only classified events count; legacy snapshots, enrollment, and future events do not alter completed days', () => {
  const entries = [protocol(), roll(), roll({ id: 'second' }), wetting('future', '08', 'forced')];
  assert.equal(trainingState(entries, new Date('2026-09-02T00:00:00Z')).probability, 55);
  const series = dailySeries(entries, 1, new Date(2026, 8, 1, 12));
  assert.equal(series[0].hold, 2);
  assert.equal(trainingState([roll()], new Date('2026-09-20T00:00:00Z')).probability, 50, 'Legacy users start fresh enrollment at 50%');
});

test('enrollment timezone handles midnight, DST and deterministic multi-device enrollments', () => {
  const enrollment = protocol({ occurredAt: '2026-03-07T12:00:00-08:00', timeZone: 'America/Los_Angeles' });
  assert.equal(trainingState([enrollment], new Date('2026-03-09T06:59:59Z')).probability, 55);
  assert.equal(trainingState([enrollment], new Date('2026-03-09T07:00:00Z')).probability, 60);
  assert.equal(protocolFor([protocol({ id: 'z' }), protocol({ id: 'a' })]).id, 'a');
  assert.equal(protocolFor([protocol({ id: 'a' }), protocol({ id: 'z' })]).id, 'a');
});

test('cooldown lasts precisely ten minutes after failure, survives correction and ignores manual results', () => {
  const failure = roll({ rolledAt: '2026-09-01T13:00:47+00:00', rolledResult: 'hold', result: 'pee', occurredAt: '2026-08-01T00:00:00+00:00' });
  assert.equal(cooldownRemaining([failure], Date.parse('2026-09-01T13:00:47Z')), 600000);
  assert.equal(cooldownRemaining([failure], Date.parse('2026-09-01T13:10:46.999Z')), 1);
  assert.equal(cooldownRemaining([failure], Date.parse('2026-09-01T13:10:47Z')), 0);
  assert.equal(cooldownRemaining([protocol({ lastFailureAt: failure.rolledAt })], Date.parse('2026-09-01T13:01:47Z')), 540000, 'Deleting the failed observation leaves the enrollment deadline');
  assert.equal(cooldownRemaining([roll({ source: 'manual' })], Date.parse('2026-09-01T12:01:00Z')), 0);
  assert.equal(cooldownRemaining([roll({ result: 'pee' })], Date.parse('2026-09-01T12:01:00Z')), 0);
  assert.equal(new Date(instantTimestamp(new Date('2026-09-01T13:00:47Z'))).toISOString(), '2026-09-01T13:00:47.000Z');
});

test('classified event backups, CSV and validation preserve types without inventing a roll result', () => {
  const event = wetting('one', '01', 'involuntary');
  const state = { ...emptyState(), entries: [protocol(), event] };
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
  assert.match(toCsv(state.entries), /involuntary/);
  assert.equal('result' in validateEntry(event), false);
  assert.throws(() => validateEntry({ ...event, category: '<script>' }));
  assert.throws(() => validateEntry(protocol({ timeZone: 'not-a-zone' })));
});

test('SQLite and sync retain enrollment, wettings, original roll times, corrections and deletions across devices', () => {
  const db = openDatabase(':memory:');
  try {
    const person = db.ensureParticipant('issuer', 'alice', 'Alice');
    const other = db.ensureParticipant('issuer', 'bob', 'Bob');
    const entries = [protocol(), wetting('one', '01', 'voluntary'), roll({ rolledAt: '2026-09-01T12:00:00+00:00', rolledResult: 'hold' })];
    let device = connectAccount(deviceState({ ...emptyState(), entries }), person, []);
    const response = db.sync(person.id, device.sync.queue);
    device = reconcile(device, response);
    const second = connectAccount(deviceState(emptyState()), person, db.records(person.id));
    assert.deepEqual(second.entries, device.entries);
    assert.equal(db.records(other.id).length, 0);
    assert.equal(db.exportRows().find(row => row.kind === 'wetting').category, 'voluntary');
    assert.equal(db.exportRows().find(row => row.kind === 'roll').rolled_result, 'hold');
    db.sync(person.id, [{ id: 'one', mutationId: 'correct', baseVersion: 1, entry: wetting('one', '01', 'involuntary') }]);
    assert.equal(trainingState(db.records(person.id).map(row => row.entry), new Date('2026-09-02T00:00:00Z')).probability, 55);
    db.sync(person.id, [{ id: 'one', mutationId: 'delete', baseVersion: 2, entry: null }]);
    assert.equal(db.records(person.id).find(row => row.id === 'one').entry, null);
  } finally { db.close(); }
});

test('version 1 database migration retains snapshots and idempotent retry receipts', () => {
  mkdirSync('artifacts', { recursive: true });
  const filename = resolve(mkdtempSync(resolve('artifacts/protocol-migration-')), 'legacy.sqlite');
  let db = openDatabase(filename);
  const person = db.ensureParticipant('issuer', 'alice', 'Alice');
  const change = { id: 'roll', mutationId: 'original', baseVersion: 0, entry: roll() };
  db.sync(person.id, [change]);
  db.close();
  const legacy = new DatabaseSync(filename);
  legacy.exec('ALTER TABLE entries DROP COLUMN payload_json; PRAGMA user_version = 1;');
  legacy.close();
  db = openDatabase(filename);
  try {
    assert.deepEqual(db.records(person.id)[0].entry, roll());
    assert.deepEqual(db.sync(person.id, [change]).ack, ['original']);
    assert.equal(db.records(person.id)[0].version, 1);
  } finally { db.close(); }
});
