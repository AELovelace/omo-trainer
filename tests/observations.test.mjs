import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, validateEntry, daySummary, dailySeries, liquidTotal, toCsv } from '../lib/model.js';
import { openDatabase } from '../server/database.mjs';
import { deviceState, connectAccount, reconcile } from '../lib/sync.js';

const observation = (id, hour, liquidsMl) => ({ id, kind: 'observation', occurredAt: `2026-09-11T${hour}:00:00+00:00`, liquidsMl, liquidsMode: 'interval', position: 'sitting', diaperNumber: 1, wettingsCount: 2, edited: false });
const draw = { id: 'draw', kind: 'roll', occurredAt: '2026-09-11T12:00:00+00:00', probability: 50, result: 'hold', source: 'random', rolledAt: '2026-09-11T12:00:00+00:00', rolledResult: 'hold' };

test('independent observations sum intake and independent rolls contribute no intake or check-in', () => {
  const entries = [observation('one', '10', 250), observation('two', '11', 400), draw];
  const summary = daySummary(entries, '2026-09-11');
  assert.equal(summary.liquidsMl, 650);
  assert.equal(summary.count, 2);
  assert.equal(summary.hold, 1);
  assert.equal(summary.latest.id, 'two');
  assert.deepEqual(dailySeries(entries, 1, new Date(2026, 8, 11, 12)), [{ day: '2026-09-11', pee: 0, hold: 1, liquidsMl: 650 }]);
  assert.equal('result' in validateEntry(entries[0]), false);
  assert.equal('liquidsMl' in validateEntry({ ...draw, liquidsMl: 999 }), false);
  assert.throws(() => validateEntry({ ...entries[0], liquidsMode: 'cumulative' }));
});

test('legacy cumulative values are not summed and do not double-count overlapping intervals', () => {
  const legacy = { id: 'old', occurredAt: '2026-09-11T11:00:00+00:00', liquidsMl: 500, position: 'sitting', diaperNumber: 1, wettingsCount: 2, probability: 50, result: 'pee', source: 'manual', edited: false };
  assert.equal(liquidTotal([legacy, { ...legacy, id: 'earlier', occurredAt: '2026-09-11T09:00:00+00:00', liquidsMl: 250 }, observation('overlap', '10', 200), observation('after', '12', 300)]), 800);
  assert.equal(daySummary([observation('one', '23', 250), { ...observation('two', '01', 100), occurredAt: '2026-09-12T01:00:00+00:00' }], '2026-09-12').liquidsMl, 100);
  assert.match(toCsv([legacy]), /cumulative/);
  assert.match(toCsv([observation('one', '10', 250)]), /interval/);
});

test('separate records and measurement modes survive SQLite, retries, second-device sync, edits and deletes', () => {
  const database = openDatabase(':memory:');
  try {
    const participant = database.ensureParticipant('issuer', 'subject', 'Participant');
    const entries = [observation('one', '10', 250), observation('two', '11', 400), draw];
    const first = connectAccount(deviceState({ ...emptyState(), entries }), participant, []);
    const response = database.sync(participant.id, first.sync.queue);
    assert.deepEqual(database.sync(participant.id, first.sync.queue).ack, response.ack);
    const second = connectAccount(deviceState(emptyState()), participant, database.records(participant.id));
    assert.deepEqual(second.entries, reconcile(first, response).entries);
    assert.equal(database.exportRows().find(row => row.entry_id === 'one').liquids_mode, 'interval');
    assert.equal(database.exportRows().find(row => row.entry_id === 'draw').liquids_ml, null);
    database.sync(participant.id, [{ id: 'two', baseVersion: 1, mutationId: 'edit', entry: { ...entries[1], liquidsMl: 100, edited: true } }]);
    assert.equal(liquidTotal(database.records(participant.id).map(row => row.entry)), 350);
    database.sync(participant.id, [{ id: 'one', baseVersion: 1, mutationId: 'delete', entry: null }]);
    assert.equal(liquidTotal(database.records(participant.id).map(row => row.entry).filter(Boolean)), 100);
  } finally { database.close(); }
});
