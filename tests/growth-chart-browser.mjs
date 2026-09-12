import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { openAuthStore } from '../auth/store.mjs';
import { openDatabase } from '../server/database.mjs';

const puppeteer = (await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
async function port() { // Choose disposable localhost ports without touching the running preview services.
  const listener = createServer();
  await new Promise(resolveReady => listener.listen(0, '127.0.0.1', resolveReady));
  const value = listener.address().port;
  await new Promise(resolveClose => listener.close(resolveClose));
  return value;
}
await mkdir('artifacts', { recursive: true });
const directory = await mkdtemp(resolve('artifacts/growth-browser-'));
const origin = 'http://127.0.0.1:' + await port(), issuer = 'http://127.0.0.1:' + await port();
Object.assign(process.env, {
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: new URL(origin).port, PUBLIC_ORIGIN: origin, BASE_PATH: '/tracker/',
  OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'little-log', DATA_DIR: resolve(directory, 'tracker'),
  AUTH_HOST: '127.0.0.1', AUTH_PORT: new URL(issuer).port, AUTH_ISSUER: issuer,
  AUTH_DATA_DIR: resolve(directory, 'auth'), AUTH_TRUST_PROXY: '0', TRACKER_REDIRECT_URI: origin + '/tracker/auth/callback',
});
const store = openAuthStore(process.env.AUTH_DATA_DIR);
const password = 'synthetic-chart-password-12345';
await store.setPassword('alice', password, true);
await store.setPassword('bob', password, true);
const aliceSubject = (await store.verify('alice', password)).id;
const bobSubject = (await store.verify('bob', password)).id;
store.close();
const { authServer } = await import('../scripts/auth-server.mjs');
const { server } = await import('../scripts/serve.mjs');
const db = openDatabase(resolve(process.env.DATA_DIR, 'little-log.sqlite'));
let browser;
const errors = [];
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('ldq-growth-chart-v2')));
async function fill(page, text) { // Use ordinary input events, keeping the test independent of keyboard timing.
  await page.$eval('#chart-name', (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); }, text);
}
async function settled(page) {
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('ldq-growth-chart-v2'));
    const { name, stars, rows, refusals, escaped, since } = state;
    return state.sync && !state.sync.pending && state.sync.base === JSON.stringify({ name, stars, rows, refusals, escaped, since }) && !document.querySelector('#chart-sync').disabled;
  }, { timeout: 15000 }).catch(async error => { throw Error(error.message + ': ' + await page.$eval('#chart-account-status', element => element.textContent)); });
}
async function signIn(page) { // Exercise the real OIDC redirect, password, consent and allowlisted chart callback.
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#chart-sign-in')]);
  if (await page.$('#username')) {
    await page.type('#username', 'alice'); await page.type('#password', password);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);
  }
  if (page.url().startsWith(issuer)) await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);
  assert.equal(page.url(), origin + '/tracker/potty_chart/');
  await page.waitForFunction(() => !document.querySelector('#chart-link').hidden || !document.querySelector('#chart-conflict').hidden);
}

try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, pipe: true });
  const context = await browser.createBrowserContext(), secondContext = await browser.createBrowserContext();
  const first = await context.newPage(), second = await secondContext.newPage();
  for (const page of [first, second]) { page.on('pageerror', error => errors.push(error.message)); await page.setViewport({ width: 390, height: 844 }); }
  await first.goto(origin + '/tracker/', { waitUntil: 'networkidle0' });
  await Promise.all([first.waitForNavigation({ waitUntil: 'networkidle0' }), first.click('#growth-chart-nav')]);
  assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Chart must fit a phone viewport');
  await fill(first, 'Device chart');
  await first.click('.star-cell:not(.is-locked):not(.is-future)');
  await signIn(first);
  const alice = db.ensureParticipant(issuer, aliceSubject, 'alice');
  assert.equal(db.growthChart(alice.id).chart, null, 'Signing in must not upload an unlinked browser chart');
  assert.equal((await saved(first)).name, 'Device chart');
  await first.click('#chart-link'); await settled(first);
  assert.equal(db.growthChart(alice.id).chart.name, 'Device chart');
  assert.equal(Object.keys(db.growthChart(alice.id).chart.stars).length, 1);
  assert.equal((await saved(first)).sync.participant.id, alice.id);
  assert.equal((await first.evaluate(async () => (await (await fetch('../api/session')).json()).participant.id)), alice.id, 'Observations and chart share one participant');

  await second.goto(origin + '/tracker/potty_chart/', { waitUntil: 'networkidle0' });
  await signIn(second);
  await second.click('#chart-use-file'); await settled(second);
  assert.equal((await saved(second)).name, 'Device chart');
  assert.equal(Object.keys((await saved(second)).stars).length, 1);
  await first.setOfflineMode(true); await fill(first, 'Offline chart');
  await first.reload({ waitUntil: 'load' });
  assert.equal((await saved(first)).name, 'Offline chart');
  await fill(second, 'Second device'); await settled(second);
  await first.setOfflineMode(false);
  await first.waitForFunction(() => !document.querySelector('#chart-sync').disabled);
  await first.click('#chart-sync');
  await first.waitForFunction(() => !document.querySelector('#chart-conflict').hidden && !document.querySelector('#chart-use-file').disabled);
  assert.equal((await saved(first)).name, 'Offline chart', 'A conflict must retain the local edit');
  await first.click('#chart-use-file'); await settled(first);
  assert.equal((await saved(first)).name, 'Second device');

  let dropped = false, editDuringUpload = false;
  await first.setRequestInterception(true);
  first.on('request', async request => {
    if (!dropped && request.method() === 'POST' && request.url().endsWith('/api/growth-chart')) {
      dropped = true;
      await fetch(request.url(), { method: 'POST', headers: request.headers(), body: request.postData() });
      await request.abort('failed'); // Commit centrally but hide the response to test the durable retry receipt.
    } else {
      if (editDuringUpload && request.method() === 'POST' && request.url().endsWith('/api/growth-chart')) {
        editDuringUpload = false;
        await fill(first, 'Newer edit'); // Edit while the previous chart snapshot is still in flight.
      }
      await request.continue();
    }
  });
  await fill(first, 'Lost response');
  await first.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('ldq-growth-chart-v2'));
    return state.sync.pending && !document.querySelector('#chart-sync').disabled;
  });
  const revision = db.growthChart(alice.id).version;
  await first.click('#chart-sync'); await settled(first);
  assert.equal(db.growthChart(alice.id).version, revision, 'Retrying the lost response must not create another revision');
  assert.equal(db.growthChart(alice.id).chart.name, 'Lost response');

  const beforeEdit = db.growthChart(alice.id).version;
  editDuringUpload = true;
  await fill(first, 'Older edit'); await settled(first);
  assert.equal(db.growthChart(alice.id).chart.name, 'Newer edit');
  assert.equal(db.growthChart(alice.id).version, beforeEdit + 2);

  const originalCookie = (await context.cookies()).find(cookie => cookie.name === 'little_log');
  const bob = db.ensureParticipant(issuer, bobSubject, 'bob');
  await context.setCookie({ ...originalCookie, value: db.createSession(bob.id) });
  await fill(first, 'Alice pending');
  await first.waitForFunction(() => document.querySelector('#chart-account-status').textContent.includes('Another account'));
  assert.match(await first.$eval('#chart-sign-in', element => element.href), /reauth=1/);
  assert.equal(db.growthChart(bob.id).chart, null, 'Switching accounts must not upload Alice data to Bob');
  await context.setCookie(originalCookie);
  await first.reload({ waitUntil: 'networkidle0' }); await settled(first);
  assert.equal(db.growthChart(alice.id).chart.name, 'Alice pending');
  await first.click('#reset-button'); await settled(first);
  assert.deepEqual(db.growthChart(alice.id).chart.stars, {});
  await first.screenshot({ path: resolve(directory, 'chart-phone.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real OAuth callback, explicit linking, shared file identity, second-device restore, offline conflict, lost-response retry, account isolation, clear and phone layout.');
} finally {
  if (browser) await browser.close();
  db.close();
  await Promise.all([new Promise(resolveClose => server.close(resolveClose)), new Promise(resolveClose => authServer.close(resolveClose))]);
}
