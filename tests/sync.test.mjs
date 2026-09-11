import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../lib/model.js';
import { deviceState, connectAccount, queueChanges, reconcile, resolveConflict } from '../lib/sync.js';

const entry = (overrides = {}) => ({ id: 'entry-1', occurredAt: '2026-09-11T12:00:00-07:00', liquidsMl: 250, position: 'sitting', diaperNumber: 1, wettingsCount: 0, probability: 50, result: 'pee', source: 'random', edited: false, ...overrides });
const participant = { id: 'person-1', label: 'Test person' };
const initial = () => deviceState({ ...emptyState(), entries: [entry()] });
const linked = () => connectAccount(initial(), participant, [], () => 'create-1');

test('first connection queues existing records and account switches cannot upload them to someone else', () => {
  const state = linked();
  assert.equal(state.sync.queue.length, 1);
  assert.equal(state.sync.queue[0].baseVersion, 0);
  assert.throws(() => connectAccount(state, { id: 'other-person', label: 'Other' }, []), /another account/);
  assert.equal(initial().sync.participant, null);
});
test('an edit made during upload stays pending when the older upload is acknowledged', () => {
  const state = linked();
  const edited = queueChanges(state, { ...state, entries: [entry({ liquidsMl: 500 })] }, () => 'edit-1');
  assert.equal(edited.sync.queue[1].baseVersion, 1);
  const result = reconcile(edited, { ack: ['create-1'], conflicts: [], records: [{ id: 'entry-1', version: 1, entry: entry() }] });
  assert.equal(result.entries[0].liquidsMl, 500);
  assert.equal(result.sync.queue[0].mutationId, 'edit-1');
});
test('pending local deletions are not resurrected by stale server snapshots', () => {
  const state = linked();
  const deleted = queueChanges(state, { ...state, entries: [] }, () => 'delete-1');
  const result = reconcile(deleted, { ack: ['create-1'], conflicts: [], records: [{ id: 'entry-1', version: 1, entry: entry() }] });
  assert.equal(result.entries.length, 0);
  assert.equal(result.sync.queue[0].entry, null);
});
test('conflicts preserve the most recent local content and allow an explicit versioned resolution', () => {
  const state = linked();
  const changed = queueChanges(state, { ...state, entries: [entry({ liquidsMl: 800 })] }, () => 'edit-1');
  const remote = { id: 'entry-1', version: 3, entry: entry({ liquidsMl: 600 }) };
  const result = reconcile(changed, { ack: [], conflicts: [remote], records: [remote] });
  assert.equal(result.sync.queue.length, 0);
  assert.equal(result.sync.conflicts[0].local.liquidsMl, 800);
  const keepLocal = resolveConflict(result, 'entry-1', true, () => 'resolution');
  assert.equal(keepLocal.sync.queue[0].baseVersion, 3);
  assert.equal(keepLocal.sync.queue[0].entry.liquidsMl, 800);
  assert.equal(resolveConflict(result, 'entry-1', false).entries[0].liquidsMl, 600);
});
test('server deletions remove unmodified cached entries and survive a local reload', () => {
  const state = linked();
  const result = reconcile(state, { ack: ['create-1'], conflicts: [], records: [{ id: 'entry-1', version: 2, entry: null }] });
  assert.equal(result.entries.length, 0);
  assert.deepEqual(deviceState(JSON.parse(JSON.stringify(result))), result);
});

test('a delayed sync response cannot replace a newer acknowledged edit or tombstone from another tab', () => {
  const state = reconcile(linked(), { ack: ['create-1'], conflicts: [], records: [{ id: 'entry-1', version: 3, entry: entry({ liquidsMl: 900 }) }] });
  const old = { ack: ['create-1'], conflicts: [], records: [{ id: 'entry-1', version: 1, entry: entry() }] };
  assert.equal(reconcile(state, old).entries[0].liquidsMl, 900);
  assert.equal(reconcile(state, old).sync.versions[0].version, 3);
  const deleted = reconcile(state, { ack: [], conflicts: [], records: [{ id: 'entry-1', version: 4, entry: null }] });
  assert.equal(reconcile(deleted, old).entries.length, 0);
});
