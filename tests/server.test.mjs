import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';

process.env.PORT = '0'; // Requests an available ephemeral port so tests never disturb the local preview server.
process.env.HOST = '127.0.0.1';
process.env.BASE_PATH = '/tracker/';
await mkdir('artifacts', { recursive: true });
process.env.DATA_DIR = await mkdtemp(resolve('artifacts/http-'));
const { server } = await import('../scripts/serve.mjs');
if (!server.listening) await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise(resolve => server.close(resolve)));

test('subpath redirects preserve relative asset and service-worker resolution', async () => {
  const response = await fetch(`${origin}/tracker`, { redirect: 'manual' });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), '/tracker/');
  const shell = await fetch(`${origin}/tracker/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Little Log/);
  assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('every install icon exists, uses PNG encoding, and matches its declared size', async () => {
  const manifestResponse = await fetch(`${origin}/tracker/manifest.webmanifest`);
  assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await manifestResponse.json();
  for (const icon of manifest.icons) {
    const response = await fetch(new URL(icon.src, `${origin}/tracker/`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const data = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, icon.sizes);
  }
});
test('service worker revalidates and private source or backup files are not served', async () => {
  const worker = await fetch(`${origin}/tracker/sw.js`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  for (const path of ['package.json', 'scripts/serve.mjs', 'tests/model.test.mjs', '.git/config', 'artifacts/desktop.png', '../README.md', '%2e%2e/README.md']) {
    assert.equal((await fetch(`${origin}/tracker/${path}`)).status, 404, path);
  }
});
test('static routes reject uploads and HEAD responses omit the body', async () => {
  const response = await fetch(`${origin}/tracker/`, { method: 'POST', body: 'private data' });
  assert.equal(response.status, 405);
  const head = await fetch(`${origin}/tracker/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('API requires authentication and rejects cross-origin and unauthenticated uploads', async () => {
  const session = await fetch(`${origin}/tracker/api/session`);
  assert.equal(session.status, 401);
  assert.equal(session.headers.get('cache-control'), 'no-store');
  const anonymous = await fetch(`${origin}/tracker/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"changes":[]}' });
  assert.equal(anonymous.status, 401);
  const crossSite = await fetch(`${origin}/tracker/api/session`, { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(crossSite.status, 403);
});


test('bundled chart stays inside the PWA and serves only its public assets under the same CSP', async () => {
  const redirect = await fetch(`${origin}/tracker/potty_chart`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/tracker/#potty-chart');
  const response = await fetch(`${origin}/tracker/potty_chart/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /name="tracker-base" content="\.\/"/);
  assert.match(html, /rel="manifest" href="\.\/manifest.webmanifest"/);
  assert.match(html, /id="page-potty-chart"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  for (const file of ['app.js', 'merge.js', 'embedded.css', 'account.js', 'crt-init.js', 'pwa.js', 'style.css', 'icons/icon-192.png', 'icons/icon-512.png']) {
    assert.equal((await fetch(`${origin}/tracker/potty_chart/${file}`)).status, 200, file);
  }
  for (const file of ['sw.js', 'README.md', 'tests/browser.mjs']) assert.equal((await fetch(`${origin}/tracker/potty_chart/${file}`)).status, 404, file);
  const manifest = await (await fetch(`${origin}/tracker/manifest.webmanifest`)).json();
  assert.equal(manifest.shortcuts[0].url, './#potty-chart');
  assert.equal(manifest.scope, './');
});


test('the actual sticker collection serves its images while original backups remain private', async () => {
  const {stickerCatalog}=await import('../server/sticker-catalog.mjs');
  const catalog=stickerCatalog();
  assert.equal(catalog.length,37);
  assert.equal(new Set(catalog.map(type=>type.id)).size,catalog.length);
  assert.ok(catalog.every(type=>!type.path.includes('/_originals/')&&type.path.startsWith('sprites/')));
  const expected=[...Array.from({length:12},(_,i)=>[String(i+1),'Sticker '+(i+1)]),...['animal','sun'].flatMap(set=>Array.from({length:set==='animal'?9:16},(_,i)=>[set+'_'+String(i+1).padStart(2,'0'),(set==='animal'?'Animal':'Sun')+' Sticker '+(i+1)]))];
  for(const [file,name] of expected) {
    const type=catalog.find(type=>type.path==='sprites/'+file+'.png');
    assert.ok(type,'Reward catalog includes '+file);assert.equal(type.name,name);
    const response=await fetch(origin+'/tracker/'+type.url);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');
    assert.deepEqual([...Buffer.from(await response.arrayBuffer()).subarray(0,8)],[137,80,78,71,13,10,26,10]);
  }
  for(const path of ['sprites/13.png','sprites/14.png','sprites/15.png','sprites/16.png','sprites/_originals/1.png','sprites/README.md','sprites/../server/economy.mjs'])assert.equal((await fetch(origin+'/tracker/'+path)).status,404);
});
