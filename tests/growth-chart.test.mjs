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
