import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openAuthStore } from '../auth/store.mjs';

await mkdir('artifacts', { recursive: true });
const directory = await mkdtemp(resolve('artifacts/registration-http-'));
const probe = createServer().listen(0, '127.0.0.1'); // Chooses a free local port before configuring the issuer's exact origin.
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolveClose => probe.close(resolveClose));
const issuer = `http://127.0.0.1:${port}`;
Object.assign(process.env, { NODE_ENV: 'test', AUTH_HOST: '127.0.0.1', AUTH_PORT: String(port), AUTH_ISSUER: issuer, AUTH_DATA_DIR: directory, AUTH_TRUST_PROXY: '1', TRACKER_REDIRECT_URI: 'http://127.0.0.1:4173/tracker/auth/callback' });
const { authServer } = await import('../scripts/auth-server.mjs');
if (!authServer.listening) await once(authServer, 'listening');
const store = openAuthStore(directory);
after(async () => { await new Promise(resolveClose => authServer.close(resolveClose)); store.close(); });

function session(address = '192.0.2.10') { // Keeps independent synthetic interaction cookies so invalid browser/session combinations can be tested.
  const cookies = new Map();
  return async (path, options = {}) => {
    const response = await fetch(new URL(path, issuer), { redirect: 'manual', ...options,
      headers: { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'X-Real-IP': address, ...options.headers },
    });
    for (const header of response.headers.getSetCookie()) {
      const [name, ...value] = header.split(';')[0].split('=');
      cookies.set(name, value.join('='));
    }
    return response;
  };
}

async function begin(address) { // Starts a genuine registered-client authorization request and loads its signup page.
  const request = session(address);
  let path = '/auth?' + new URLSearchParams({ client_id: 'little-log', response_type: 'code', redirect_uri: process.env.TRACKER_REDIRECT_URI,
    scope: 'openid profile', code_challenge: createHash('sha256').update('test-verifier-'.repeat(4)).digest('base64url'), code_challenge_method: 'S256', screen_hint: 'signup', prompt: 'login',
  });
  for (let count = 0; count < 5; count++) {
    const response = await request(path);
    if (response.status === 303 || response.status === 302) { path = response.headers.get('location'); continue; }
    assert.equal(response.status, 200, await response.clone().text());
    const html = await response.text();
    assert.match(path, /\/interaction\/.+\/register$/);
    return { request, path, csrf: html.match(/name="csrf" value="([^"]+)"/)[1], html };
  }
  throw new Error('Signup redirect did not complete');
}

function submit(flow, fields = {}, headers = {}) { // Sends registration directly so server validation is tested independently of HTML constraints.
  return flow.request(flow.path, { method: 'POST', headers: { Origin: issuer, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ csrf: flow.csrf, username: 'candidate', password: 'synthetic-new-password', confirmPassword: 'synthetic-new-password', ageConfirmed: 'yes', ...fields }),
  });
}

test('signup pages require an OIDC interaction and use uncached, isolated forms', async () => {
  const flow = await begin();
  assert.match(flow.html, /autocomplete="new-password"/);
  assert.match(flow.html, /<input id="age-confirmed" name="ageConfirmed" type="checkbox" value="yes" required>/);
  const response = await flow.request(flow.path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const login = await flow.request(flow.path.replace('/register', ''));
  const loginHtml = await login.text();
  assert.match(loginHtml, /id="create-account-link"/);
  assert.doesNotMatch(loginHtml, /id="age-confirmed"/);
  assert.equal((await session()(flow.path)).status, 400, 'A URL without the matching interaction cookie is insufficient');
  assert.equal((await flow.request('/interaction/expired/register')).status, 400);
  assert.equal(store.list().length, 0);
});

test('registration rejects foreign origins, absent tokens, and login tokens reused for signup', async () => {
  const flow = await begin('192.0.2.11');
  assert.equal((await submit(flow, {}, { Origin: 'https://foreign.example' })).status, 400);
  assert.equal((await submit(flow, { csrf: '' })).status, 400);
  const loginHtml = await (await flow.request(flow.path.replace('/register', ''))).text();
  assert.equal((await submit(flow, { csrf: loginHtml.match(/name="csrf" value="([^"]+)"/)[1] })).status, 400);
  assert.equal(store.list().length, 0);
});

test('registration validates credentials and confirmation without reflecting passwords or executable input', async () => {
  const flow = await begin('192.0.2.12');
  for (const [fields, message] of [
    [{ password: 'short', confirmPassword: 'short' }, /12–128/],
    [{ username: '<img src=x onerror=alert(1)>' }, /Start with a letter/],
    [{ confirmPassword: 'different-password-value' }, /Passwords do not match/],
    [{ username: 'x'.repeat(41) }, /3–40/],
    [{ password: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) }, /12–128/],
  ]) {
    const response = await submit(flow, fields);
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, message);
    assert.doesNotMatch(html, /synthetic-new-password|<img|value="short"/);
  }
  assert.equal(store.list().length, 0);
});

test('registration requires explicit adult confirmation before creating an account', async () => {
  const flow = await begin('192.0.2.16');
  const before = store.list().length;
  // Direct requests verify that HTML's required checkbox cannot be bypassed.
  for (const value of [null, '', 'no', 'false', 'true', 'on']) {
    const body = new URLSearchParams({ csrf: flow.csrf, username: 'unconfirmed-user', password: 'synthetic-new-password', confirmPassword: 'synthetic-new-password' });
    if (value !== null) body.set('ageConfirmed', value);
    const response = await flow.request(flow.path, { method: 'POST', headers: { Origin: issuer, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Confirm that you are 18 or older/);
    assert.equal(store.list().length, before, 'Unconfirmed registration must not create an identity');
  }
});

test('signup normalizes usernames, persists an identity, and rejects replay and duplicate password replacement', async () => {
  const flow = await begin('192.0.2.13');
  const response = await submit(flow, { username: '  New.User  ' });
  assert.equal(response.status, 303);
  const account = await store.verify('new.user', 'synthetic-new-password');
  assert.ok(account?.id);
  assert.equal((await submit(flow, { username: 'replayed-user' })).status, 400);
  const duplicate = await begin('192.0.2.14');
  const rejected = await submit(duplicate, { username: 'NEW.USER', password: 'replacement-password', confirmPassword: 'replacement-password' });
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /username is unavailable/);
  assert.equal((await store.verify('new.user', 'synthetic-new-password')).id, account.id);
  assert.equal(await store.verify('new.user', 'replacement-password'), null);
  assert.equal(store.list().length, 1);
});

test('signup throttling rejects excess requests without creating accounts and survives reopening the database', async () => {
  const flow = await begin('192.0.2.15');
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await submit(flow, { confirmPassword: 'mismatch' })).status, 400);
  const blocked = await submit(flow, { username: 'blocked-user' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  const reopened = openAuthStore(directory);
  try {
    assert.equal(reopened.rateLimit('registration:ip:192.0.2.15', 10), false);
    assert.equal(reopened.list().some(account => account.username === 'blocked-user'), false);
  } finally { reopened.close(); }
});
