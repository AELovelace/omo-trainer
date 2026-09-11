import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openAuthStore } from '../auth/store.mjs';
import { checkedUrl } from '../auth/config.mjs';

test('shared passwords verify securely, reset preserves identity, and disabled users cannot sign in', async () => {
  await mkdir('artifacts', { recursive: true });
  const directory = await mkdtemp(resolve('artifacts/auth-'));
  const store = openAuthStore(directory);
  try {
    await store.setPassword('alice', 'test-password-12345', true);
    const first = await store.verify('alice', 'test-password-12345');
    assert.ok(first?.id);
    assert.equal(await store.verify('alice', 'wrong-password'), null);
    assert.equal(await store.verify('unknown', 'test-password-12345'), null);
    await store.setPassword('alice', 'different-password-12345');
    assert.equal((await store.verify('alice', 'different-password-12345')).id, first.id);
    assert.equal(await store.verify('alice', 'test-password-12345'), null);
    store.disable('alice');
    assert.equal(await store.verify('alice', 'different-password-12345'), null);
    assert.equal(store.account(first.id), undefined);
  } finally { store.close(); }
});
test('OIDC codes retain consumed state, grant revocation removes tokens, and sessions persist after restart', async () => {
  const directory = await mkdtemp(resolve('artifacts/adapter-'));
  let store = openAuthStore(directory);
  let adapter = new store.Adapter('AuthorizationCode');
  await adapter.upsert('code', { grantId: 'grant', uid: 'uid' }, 600);
  await adapter.consume('code');
  assert.ok((await adapter.find('code')).consumed);
  store.close();
  store = openAuthStore(directory);
  adapter = new store.Adapter('AuthorizationCode');
  assert.ok((await adapter.findByUid('uid')).consumed);
  await adapter.revokeByGrantId('grant');
  assert.equal(await adapter.find('code'), undefined);
  for (let index = 0; index < 10; index++) assert.equal(store.rateLimit('user:alice'), true);
  assert.equal(store.rateLimit('user:alice'), false);
  store.close();
});
test('authentication URLs require HTTPS except for explicit loopback development', () => {
  assert.equal(checkedUrl('https://auth.lidoll.dev').origin, 'https://auth.lidoll.dev');
  assert.equal(checkedUrl('http://127.0.0.1:4180').protocol, 'http:');
  for (const url of ['http://auth.lidoll.dev', 'https://user:secret@auth.lidoll.dev', 'javascript:alert(1)', 'https://lidoll.dev/#fragment']) assert.throws(() => checkedUrl(url));
});
