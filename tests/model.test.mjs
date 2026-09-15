import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, validateEntry, validateState, validateTimestamp, timestampFromInput, localInput,
  rollResult, daySummary, dailySeries, mergeBackup, toCsv, sortedEntries } from '../lib/model.js';

const entry = (overrides = {}) => ({ // Makes a complete baseline record for behavioral and malformed-import tests.
  id: 'test-1', occurredAt: '2026-09-11T14:30:00-07:00', liquidsMl: 250, position: 'sitting',
  diaperNumber: 1, wettingsCount: 0, probability: 50, result: 'pee', source: 'random', edited: false, ...overrides,
});

test('probability boundaries are exact and do not draw randomness', () => {
  const unexpected = () => { throw new Error('Should not draw'); };
  assert.equal(rollResult(0, unexpected), 'hold');
  assert.equal(rollResult(100, unexpected), 'pee');
});
test('every probability gives exactly that many pee outcomes per 100 equally likely draws', () => {
  for (let probability = 0; probability <= 100; probability++) {
    let pee = 0;
    for (let sample = 0; sample < 100; sample++) pee += rollResult(probability, () => sample) === 'pee';
    assert.equal(pee, probability);
  }
});
test('rejection sampling discards biased tail values', () => {
  const draws = [4294967295, 4294967200, 4294967199];
  assert.equal(rollResult(99, () => draws.shift()), 'hold');
  assert.equal(draws.length, 0);
});
test('unsupported fractional, absent, nonfinite, and out-of-range probabilities are rejected', () => {
  for (const probability of [-1, 101, .25, NaN, Infinity, '50', null, undefined]) assert.throws(() => rollResult(probability));
});
test('cumulative liquids are a maximum, not a sum; latest counts come from the latest snapshot', () => {
  const entries = [entry(), entry({ id: 'test-2', occurredAt: '2026-09-11T17:00:00-07:00', liquidsMl: 500, diaperNumber: 2, wettingsCount: 3, result: 'hold' })];
  const summary = daySummary(entries, '2026-09-11');
  assert.equal(summary.liquidsMl, 500);
  assert.equal(summary.count, 2);
  assert.equal(summary.pee, 1);
  assert.equal(summary.hold, 1);
  assert.equal(summary.latest.diaperNumber, 2);
  assert.equal(summary.latest.wettingsCount, 3);
  assert.equal(daySummary(entries, '2026-09-12').latest, null);
});
test('original local dates survive UTC midnight and different offsets', () => {
  const entries = [entry({ occurredAt: '2026-09-11T23:30:00-07:00' })];
  assert.equal(daySummary(entries, '2026-09-11').count, 1);
  assert.equal(daySummary(entries, '2026-09-12').count, 0);
});
test('same-minute check-ins prefer the most recently inserted record', () => {
  assert.equal(sortedEntries([entry(), entry({ id: 'second' })])[0].id, 'second');
});
test('series zero-fills days and crosses a month and DST boundary without duplicates', () => {
  const series = dailySeries([entry({ occurredAt: '2026-03-08T14:30:00-07:00' })], 12, new Date(2026, 2, 10, 12));
  assert.equal(series[0].day, '2026-02-27');
  assert.equal(series.at(-1).day, '2026-03-10');
  assert.equal(new Set(series.map(row => row.day)).size, 12);
  assert.equal(series.find(row => row.day === '2026-03-08').pee, 1);
  assert.equal(series[0].liquidsMl, 0);
});
test('invalid calendar dates and offsets are rejected', () => {
  for (const date of ['2026-02-30T10:00:00+00:00', '2026-13-01T10:00:00+00:00', '2026-09-11T24:00:00+00:00', '2026-09-11T10:00:00+14:30', '2026-09-11', '1999-09-11T10:00:00+00:00']) assert.throws(() => validateTimestamp(date));
  assert.equal(validateTimestamp('2024-02-29T10:00:00+05:30'), '2024-02-29T10:00:00+05:30');
});
test('datetime-local round trips wall time and writes an explicit offset', () => {
  const input = localInput(new Date(2026, 8, 11, 14, 30));
  const timestamp = timestampFromInput(input);
  assert.equal(timestamp.slice(0, 16), input);
  assert.match(timestamp, /[+-]\d\d:\d\d$/);
  assert.throws(() => timestampFromInput('2026-02-30T10:00'));
});
test('validation rejects unsafe strings and malformed numeric fields and strips extras', () => {
  for (const override of [{ id: '<script>' }, { position: '<img onerror=alert(1)>' }, { result: 'other' }, { source: 'unknown' }, { liquidsMl: -1 }, { wettingsCount: .5 }, { diaperNumber: 0 }, { edited: 'true' }]) assert.throws(() => validateEntry(entry(override)));
  assert.equal('unexpected' in validateEntry(entry({ unexpected: 'discard me' })), false);
});
test('valid backups round-trip and duplicate IDs or unknown versions fail atomically', () => {
  const state = { ...emptyState(), entries: [entry()] };
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))), state);
  assert.throws(() => validateState({ ...state, version: 2 }));
  assert.throws(() => validateState({ ...state, entries: [entry(), entry()] }));
});
test('imports deduplicate exact matches and keep current preferences', () => {
  const current = { ...emptyState(), entries: [entry()] };
  const backup = { version: 1, settings: { probability: 12, position: 'standing' }, entries: [entry(), entry({ id: 'new' })] };
  const merged = mergeBackup(current, backup);
  assert.equal(merged.added, 1);
  assert.equal(merged.state.entries.length, 2);
  assert.equal(merged.state.settings.probability, 50);
  assert.equal(current.entries.length, 1);
});
test('conflicting imports preserve existing data and do not partially add new IDs', () => {
  const current = { ...emptyState(), entries: [entry()] };
  assert.throws(() => mergeBackup(current, { ...emptyState(), entries: [entry({ id: 'new' }), entry({ liquidsMl: 900 })] }), /changed version/);
  assert.equal(current.entries.length, 1);
});
test('CSV includes units, probability, source, timezone, and independent wetting snapshots', () => {
  const csv = toCsv([entry({ probability: 0, result: 'hold', wettingsCount: 4 })]);
  assert.match(csv, /"liquidsMl"/);
  assert.match(csv, /2026-09-11T14:30:00-07:00/);
  assert.match(csv, /"4","0","hold","random","false"/);
  assert.equal(csv.split('\r\n').length, 2);
});
