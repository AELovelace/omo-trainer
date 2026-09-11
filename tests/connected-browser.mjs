import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import * as oidc from 'openid-client';
import { openAuthStore } from '../auth/store.mjs';
import { openDatabase } from '../server/database.mjs';

const puppeteer = (await import(process.env.PUPPETEER_MODULE ? pathToFileURL(process.env.PUPPETEER_MODULE).href : 'puppeteer-core')).default;
if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium executable.');
await mkdir('artifacts', { recursive: true });
const directory = await mkdtemp(resolve('artifacts/connected-'));
const authDirectory = resolve(directory, 'identity');
const dataDirectory = resolve(directory, 'tracker');
const origin = 'http://127.0.0.1:43173';
const issuer = 'http://127.0.0.1:43180';
const password = 'synthetic-test-password-12345';
const store = openAuthStore(authDirectory);
await store.setPassword('alice', password, true);
await store.setPassword('bob', password, true);
const aliceSubject = (await store.verify('alice', password)).id;
store.close();
await writeFile(resolve(authDirectory, 'clients.json'), JSON.stringify(['little-log', 'future-app'].map(id => ({
  client_id: id, client_name: id, redirect_uris: [`${origin}/${id === 'little-log' ? 'tracker/auth/callback' : 'future/callback'}`],
  response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none',
}))));
const services = [];
const errors = [];
let browser;

async function service(script, environment, readyText) { // Runs isolated test services against throwaway databases, never the live preview data directory.
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  services.push(child);
  let output = '';
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service did not start: ${output}`)), 15000);
    child.stdout.on('data', data => { output += data; if (output.includes(readyText)) { clearTimeout(timer); resolveReady(); } });
    child.stderr.on('data', data => { output += data; child.testDiagnostics = output; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited ${code}: ${output}`)); });
  });
}

async function fill(page, selector, value) { // Updates synthetic form data without relying on browser-specific typing shortcuts.
  await page.$eval(selector, (element, next) => { element.value = next; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, String(value));
}
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('lidoll.little-log.v1')));
async function settled(page, count) { // Waits for both the expected local count and a confirmed server acknowledgement.
  await page.waitForFunction(expected => {
    const state = JSON.parse(localStorage.getItem('lidoll.little-log.v1'));
    return state?.sync.participant && state.entries.length === expected && state.sync.queue.length === 0 && state.sync.conflicts.length === 0;
  }, { timeout: 20000 }, count).catch(async error => { throw new Error(`${error.message}: ${await page.$eval('#sync-status', element => element.textContent)}; ${JSON.stringify(await saved(page))}`); });
}
async function signIn(page, username) { // Exercises a real authorization-code + PKCE redirect, shared login, consent, and callback.
  await page.click('[data-page="settings"]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#connect-account')]);
  await page.waitForSelector('#username');
  await page.screenshot({ path: resolve(directory, 'auth-signin.png'), fullPage: true }); // Captures the shared identity theme before any synthetic password is entered.
  await fill(page, '#username', username);
  await fill(page, '#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);
  if (page.url().startsWith(`${issuer}/interaction/`)) {
    assert.equal(await page.$('#username'), null, 'A successful password login should reach consent');
    assert.ok(await page.$('button[type="submit"]'), await page.$eval('body', element => element.innerText));
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('button[type="submit"]')]);
  }
  assert.match(page.url(), /\/tracker\/#settings$/, await page.$eval('body', element => element.innerText));
}

try {
  await service('scripts/auth-server.mjs', { AUTH_PORT: '43180', AUTH_HOST: '127.0.0.1', AUTH_ISSUER: issuer, AUTH_DATA_DIR: authDirectory, AUTH_TRUST_PROXY: '0' }, 'accounts listening');
  await service('scripts/serve.mjs', { PORT: '43173', HOST: '127.0.0.1', PUBLIC_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'little-log', DATA_DIR: dataDirectory }, 'Little Log is running');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const aliceContext = await browser.createBrowserContext();
  const alice = await aliceContext.newPage();
  alice.on('pageerror', error => errors.push(error.message));
  await alice.goto(`${origin}/tracker/`, { waitUntil: 'networkidle0' });
  await fill(alice, '#liquids', 400);
  await fill(alice, '#probability', 100);
  await alice.click('.roll-button');
  await signIn(alice, 'alice');
  await settled(alice, 1);
  console.log('PASS: OIDC login and migration of existing local entries');

  const csrfBlocked = await alice.evaluate(async () => (await fetch('./api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"changes":[]}' })).status);
  assert.equal(csrfBlocked, 403);
  const cookieNames = await alice.cookies();
  assert.equal(cookieNames.find(cookie => cookie.name === 'little_log').httpOnly, true);

  const secondContext = await browser.createBrowserContext();
  const second = await secondContext.newPage();
  second.on('pageerror', error => errors.push(error.message));
  await second.goto(`${origin}/tracker/`, { waitUntil: 'networkidle0' });
  await signIn(second, 'alice');
  await settled(second, 1);
  assert.equal((await saved(second)).entries[0].liquidsMl, 400);
  await second.evaluate(() => navigator.serviceWorker.ready);
  await second.setOfflineMode(true);
  await second.click('[data-page="overview"]');
  await fill(second, '#liquids', 700);
  await second.click('.roll-button');
  assert.equal((await saved(second)).sync.queue.length, 1);
  await second.reload({ waitUntil: 'networkidle0' });
  assert.equal((await saved(second)).entries.length, 2);
  await second.setOfflineMode(false);
  await second.click('[data-page="settings"]');
  await second.click('#sync-now');
  await settled(second, 2);
  await alice.click('#sync-now');
  await settled(alice, 2);
  console.log('PASS: independent device restore, offline save/reload, and reconnect');

  const bobContext = await browser.createBrowserContext();
  const bob = await bobContext.newPage();
  await bob.goto(`${origin}/tracker/`, { waitUntil: 'networkidle0' });
  await signIn(bob, 'bob');
  await settled(bob, 0);
  assert.notEqual((await saved(bob)).sync.participant.id, (await saved(alice)).sync.participant.id);
  console.log('PASS: participant isolation');

  await second.setOfflineMode(true);
  await second.click('[data-page="history"]');
  await second.click('[data-edit]');
  await fill(second, '#edit-liquids', 900);
  await second.click('#edit-form button[type="submit"]');
  await alice.click('[data-page="history"]');
  await alice.click('[data-edit]');
  await fill(alice, '#edit-liquids', 800);
  await alice.click('#edit-form button[type="submit"]');
  await settled(alice, 2);
  await second.setOfflineMode(false);
  await second.click('[data-page="settings"]');
  await second.click('#sync-now');
  await second.waitForSelector('.sync-conflict');
  assert.equal((await saved(second)).sync.conflicts[0].local.liquidsMl, 900);
  await second.click('.sync-conflict button');
  await settled(second, 2);
  await alice.click('[data-page="settings"]');
  await alice.click('#sync-now');
  await alice.waitForFunction(() => JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.some(entry => entry.liquidsMl === 900));
  console.log('PASS: concurrent edits require an explicit conflict choice');

  const sso = await aliceContext.newPage();
  const client = await oidc.discovery(new URL(issuer), 'future-app', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] });
  const verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce(), state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(client, { redirect_uri: `${origin}/future/callback`, scope: 'openid profile', code_challenge_method: 'S256', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), nonce, state });
  await sso.goto(url.href, { waitUntil: 'networkidle0' });
  assert.equal(await sso.$('#username'), null, 'A second app should reuse the shared login without asking for a password');
  await Promise.all([sso.waitForNavigation({ waitUntil: 'networkidle0' }), sso.click('button[type="submit"]')]);
  const callback = new URL(sso.url());
  const tokens = await oidc.authorizationCodeGrant(client, callback, { pkceCodeVerifier: verifier, expectedNonce: nonce, expectedState: state, idTokenExpected: true });
  assert.equal(tokens.claims().sub, aliceSubject);
  assert.equal(tokens.claims().aud, 'future-app');
  await assert.rejects(() => oidc.authorizationCodeGrant(client, callback, { pkceCodeVerifier: verifier, expectedNonce: nonce, expectedState: state, idTokenExpected: true }));
  console.log('PASS: a second OIDC app reuses the account; authorization codes cannot be replayed');

  const database = openDatabase(resolve(dataDirectory, 'little-log.sqlite'));
  const rows = database.exportRows();
  assert.equal(rows.length, 2);
  assert.ok(rows.some(row => row.liquids_ml === 900));
  assert.ok(rows.every(row => row.participant_id === (rows[0].participant_id)));
  database.close();
  console.log('PASS: central analysis export');
  await alice.bringToFront();
  await alice.setViewport({ width: 390, height: 844 });
  await alice.screenshot({ path: resolve(directory, 'connected-settings.png'), fullPage: true });
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS: mobile settings');
  await alice.waitForFunction(() => !document.querySelector('#sync-now').disabled);
  alice.once('dialog', dialog => dialog.accept());
  await alice.click('#disconnect-account');
  console.log('Sign-out requested');
  await alice.waitForFunction(() => localStorage.getItem('lidoll.little-log.v1') === null);
  assert.equal(await alice.evaluate(async () => (await fetch('./api/session')).status), 401);
  assert.deepEqual(errors, []);
  console.log('PASS: central analysis export, mobile settings, HttpOnly logout, and device-cache clearing');
  console.log(`Connected browser suite passed. Synthetic artifacts: ${directory}`);
} catch (error) {
  for (const child of services) console.error(child.testDiagnostics ?? '');
  throw error;
} finally {
  await browser?.close();
  for (const child of services) child.kill(); // Stops only service processes started by this isolated test run.
}
