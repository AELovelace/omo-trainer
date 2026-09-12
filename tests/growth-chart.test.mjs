import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { openDatabase } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';
import { validateGrowthChart } from '../server/growth-chart.mjs';

const chart = () => ({ name: 'Test visitor', stars: { '2026-09-11:diaper': true }, rows: [
  { id: 'diaper', label: 'Daily row', note: '', praise: 'Saved.', locked: false },
  { id: 'potty', label: 'Asked for the potty', note: '', locked: true },
], refusals: 2, escaped: false, since: '2026-09-01' });
const change = (baseVersion = 0, mutationId = 'first', value = chart()) => ({ baseVersion, mutationId, chart: value });

test('chart validation bounds fields and rejects impossible dates, locked stars and malformed rows', () => {
  assert.deepEqual(validateGrowthChart({ ...chart(), token: 'must-not-store' }), chart());
  for (const input of [
    { ...chart(), name: 'x'.repeat(25) }, { ...chart(), since: '2026-02-30' },
    { ...chart(), stars: { '2026-02-30:diaper': true } }, { ...chart(), stars: { '2026-09-11:potty': true } },
    { ...chart(), stars: { '2026-09-11:missing': true } }, { ...chart(), stars: [] },
    { ...chart(), rows: [chart().rows[0]] }, { ...chart(), rows: [...chart().rows, chart().rows[0]] },
    { ...chart(), refusals: -1 }, { ...chart(), rows: Array(17).fill(chart().rows[0]) },
  ]) assert.throws(() => validateGrowthChart(input));
});

test('charts and receipts persist, isolate participants, and prevent stale edits from resurrecting cleared stars', async () => {
  await mkdir('artifacts', { recursive: true });
  const path = resolve(await mkdtemp(resolve('artifacts/growth-')), 'chart.sqlite');
  let db = openDatabase(path);
  const alice = db.ensureParticipant('https://auth.sadgirlsclub.wtf', 'alice', 'Alice');
  const bob = db.ensureParticipant('https://auth.sadgirlsclub.wtf', 'bob', 'Bob');
  assert.equal(db.saveGrowthChart(alice.id, change()).version, 1);
  db.close(); db = openDatabase(path);
  try {
    assert.equal(db.saveGrowthChart(alice.id, change()).version, 1);
    assert.equal(db.growthChart(bob.id).chart, null);
    assert.throws(() => db.saveGrowthChart(alice.id, change(0, 'stale')), error => error.status === 409);
    assert.throws(() => db.saveGrowthChart(alice.id, change(0, 'first', { ...chart(), name: 'Changed' })), error => error.status === 400);
    assert.equal(db.saveGrowthChart(alice.id, change(1, 'clear', { ...chart(), stars: {} })).version, 2);
    assert.equal(db.saveGrowthChart(alice.id, change()).version, 1, 'A lost response acknowledges its original revision');
    assert.deepEqual(db.growthChart(alice.id).chart.stars, {}, 'An old retry must not rewrite the current file');
    assert.equal(db.saveGrowthChart(bob.id, change()).version, 1);
    assert.deepEqual(db.growthChart(bob.id).chart.stars, chart().stars);
  } finally { db.close(); }
});

test('row meanings and dated star associations survive renames, account isolation, reopening and exports', async () => {
  await mkdir('artifacts', { recursive: true });
  const path = resolve(await mkdtemp(resolve('artifacts/growth-rows-')), 'chart.sqlite');
  let db = openDatabase(path);
  try {
    const alice = db.ensureParticipant('issuer', 'alice', 'Alice');
    const bob = db.ensureParticipant('issuer', 'bob', 'Bob');
    const aliceChart = {
      ...chart(),
      rows: [
        { id: 'diaper', label: 'Morning check-in', note: 'Recorded before breakfast', praise: 'Saved.', locked: false },
        { id: 'custom_evening', label: 'Morning check-in', note: 'A separate user-defined task', locked: false },
        chart().rows[1],
      ],
      stars: { '2026-09-10:diaper': true, '2026-09-11:custom_evening': true },
    };
    const bobChart = {
      ...chart(),
      rows: [{ ...chart().rows[0], label: 'Evening routine', note: 'Bob uses this ID differently' }, chart().rows[1]],
    };
    db.saveGrowthChart(alice.id, change(0, 'alice-rows', aliceChart));
    db.saveGrowthChart(bob.id, change(0, 'bob-rows', bobChart));

    const renamed = structuredClone(aliceChart);
    renamed.rows[0].label = 'Breakfast routine';
    renamed.rows[0].note = 'Updated description for this chart line';
    renamed.rows = [renamed.rows[1], renamed.rows[0], renamed.rows[2]]; // Position and duplicate labels must never determine star identity.
    db.saveGrowthChart(alice.id, change(1, 'alice-rename', renamed));
    db.close(); db = openDatabase(path);

    const restored = db.growthChart(alice.id).chart;
    assert.deepEqual(restored, renamed, 'Persist the complete user-authored row definitions with the stars');
    assert.deepEqual(db.growthChart(bob.id).chart, bobChart, 'Another user sharing a row ID retains their own meaning');
    const meanings = Object.keys(restored.stars).sort().map(key => {
      const [date, rowId] = key.split(':');
      const row = restored.rows.find(candidate => candidate.id === rowId);
      return { date, rowId, label: row.label, note: row.note }; // Resolve within this participant's saved rows, never from a global default.
    });
    assert.deepEqual(meanings, [
      { date: '2026-09-10', rowId: 'diaper', label: 'Breakfast routine', note: 'Updated description for this chart line' },
      { date: '2026-09-11', rowId: 'custom_evening', label: 'Morning check-in', note: 'A separate user-defined task' },
    ]);
    const exported = JSON.parse(JSON.stringify(db.exportCharts())); // Operator JSON exports must retain the same row-to-star relationship.
    assert.deepEqual(exported.find(value => value.participantId === alice.id).chart, renamed);
    assert.deepEqual(exported.find(value => value.participantId === bob.id).chart, bobChart);
  } finally { db.close(); }
});

test('explicit issuer migration preserves participant IDs and charts, invalidates sessions, and refuses collisions atomically', () => {
  const db = openDatabase(':memory:');
  try {
    const alice = db.ensureParticipant('https://old.example', 'stable-subject', 'Alice');
    db.saveGrowthChart(alice.id, change());
    const token = db.createSession(alice.id);
    assert.equal(db.migrateIssuer('https://old.example', 'https://auth.sadgirlsclub.wtf'), 1);
    assert.equal(db.session(token), null);
    assert.equal(db.ensureParticipant('https://auth.sadgirlsclub.wtf', 'stable-subject', 'Alice').id, alice.id);
    assert.deepEqual(db.growthChart(alice.id).chart, chart());
    db.ensureParticipant('https://old.example', 'stable-subject', 'Other');
    assert.throws(() => db.migrateIssuer('https://old.example', 'https://auth.sadgirlsclub.wtf'), /collision/);
    assert.equal(db.list().length, 2);
    assert.deepEqual(db.growthChart(alice.id).chart, chart());
  } finally { db.close(); }
});

test('chart API enforces sessions, CSRF, origin and server-owned identity', async () => {
  const db = openDatabase(':memory:');
  const alice = db.ensureParticipant('issuer', 'alice', 'Alice'), bob = db.ensureParticipant('issuer', 'bob', 'Bob');
  const token = db.createSession(alice.id), session = db.session(token);
  const login = { origin: '', session: request => db.session(request.headers.cookie) };
  const api = createApi(db, login);
  const server = createServer((request, response) => api(request, response, 'growth-chart'));
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  login.origin = 'http://127.0.0.1:' + server.address().port;
  const get = headers => fetch(login.origin, { headers });
  const post = (headers = {}, payload = change()) => fetch(login.origin, {
    method: 'POST', headers: { Cookie: token, Origin: login.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, ...headers },
    body: JSON.stringify(payload),
  });
  try {
    assert.equal((await get({})).status, 401);
    assert.equal((await get({ Cookie: token, Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post({ 'X-CSRF-Token': 'wrong' })).status, 403);
    assert.equal((await post({ Origin: 'https://foreign.example' })).status, 403);
    const response = await post({}, { ...change(), participantId: bob.id });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).participant.id, alice.id);
    assert.equal(db.growthChart(bob.id).chart, null);
    assert.equal((await post({}, change(0, 'stale'))).status, 409);
    const loaded = await (await get({ Cookie: token })).json();
    assert.equal(loaded.version, 1);
    assert.deepEqual(loaded.chart, chart());
  } finally { await new Promise(resolveClose => server.close(resolveClose)); db.close(); }
});
