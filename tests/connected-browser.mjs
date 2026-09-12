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
await store.setPassword('bob', password, true);
let aliceSubject; // Alice is created through the public registration UI; Bob exercises the existing administrator-created account path.
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
const saved = page => page.evaluate(() => { const state = JSON.parse(localStorage.getItem('lidoll.little-log.v1')); if (state) state.entries = state.entries.filter(entry => entry.kind !== 'protocol'); return state; });
async function settled(page, count) { // Waits for both the expected local count and a confirmed server acknowledgement.
  await page.waitForFunction(expected => {
    const state = JSON.parse(localStorage.getItem('lidoll.little-log.v1'));
    return state?.sync.participant && state.entries.filter(entry => entry.kind !== 'protocol').length === expected && state.sync.queue.length === 0 && state.sync.conflicts.length === 0;
  }, { timeout: 20000 }, count).catch(async error => { throw new Error(`${error.message}: ${await page.$eval('#sync-status', element => element.textContent)}; ${JSON.stringify(await saved(page))}`); });
}
async function signIn(page, username, fromHeader = false) { // Exercises both sign-in entry points through the real shared identity and callback flow.
  await page.click(`[data-page="${fromHeader ? 'history' : 'settings'}"]`);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(fromHeader ? '#topbar-sign-in' : '#connect-account')]);
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
  if (fromHeader) {
    await page.waitForFunction(() => document.querySelector('#topbar-sign-in').textContent === 'Connect device');
    assert.equal((await saved(page))?.sync.participant ?? null, null, 'Header sign-in must not silently approve uploading records');
    await page.click('[data-page="overview"]');
    await page.click('#topbar-sign-in');
    await page.waitForFunction(() => !document.querySelector('#page-settings').hidden && document.activeElement.id === 'connect-account');
    await page.click('#connect-account');
    await page.waitForFunction(() => document.querySelector('#topbar-sign-in').hidden);
  }
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
  await alice.evaluate(() => { crypto.getRandomValues = values => { values.fill(0); return values; }; });
  await alice.click('.roll-button');
  await alice.click('[data-page="settings"]');
  await Promise.all([alice.waitForNavigation({ waitUntil: 'networkidle0' }), alice.click('#register-account')]);
  await alice.waitForSelector('#confirm-password');
  await alice.setViewport({ width: 1280, height: 1100 });
  await alice.screenshot({ path: resolve(directory, 'registration-desktop.png'), fullPage: true });
  for (const width of [320, 390]) {
    await alice.setViewport({ width, height: 844 });
    assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Registration must fit ${width}px`);
  }
  await alice.screenshot({ path: resolve(directory, 'registration-mobile.png'), fullPage: true });
  await fill(alice, '#username', 'alice');
  await fill(alice, '#password', password);
  await fill(alice, '#confirm-password', 'mismatched-password-value');
  await Promise.all([alice.waitForNavigation({ waitUntil: 'networkidle0' }), alice.click('button[type="submit"]')]);
  assert.match(await alice.$eval('#form-error', element => element.textContent), /Passwords do not match/);
  assert.equal(await alice.$eval('#password', element => element.value), '', 'Validation must not echo passwords');
  await fill(alice, '#username', 'bob');
  await fill(alice, '#password', password);
  await fill(alice, '#confirm-password', password);
  await Promise.all([alice.waitForNavigation({ waitUntil: 'networkidle0' }), alice.click('button[type="submit"]')]);
  assert.match(await alice.$eval('#form-error', element => element.textContent), /username is unavailable/);
  await fill(alice, '#username', 'Alice');
  await fill(alice, '#password', password);
  await fill(alice, '#confirm-password', password);
  await Promise.all([alice.waitForNavigation({ waitUntil: 'networkidle0' }), alice.click('button[type="submit"]')]);
  assert.equal(await alice.$('#password'), null, 'Successful registration must proceed to app consent');
  assert.match(await alice.$eval('h1', element => element.textContent), /Authorize access/);
  await Promise.all([alice.waitForNavigation({ waitUntil: 'networkidle0' }), alice.click('button[type="submit"]')]);
  assert.match(alice.url(), /\/tracker\/#settings$/);
  await alice.waitForFunction(() => document.querySelector('#connect-account').textContent === 'Connect & upload my entries');
  assert.equal((await saved(alice)).sync.participant, null, 'Registration must leave uploading local records as an explicit choice');
  const registeredStore = openAuthStore(authDirectory);
  aliceSubject = (await registeredStore.verify('alice', password)).id;
  registeredStore.close();
  await alice.click('#connect-account');
  await settled(alice, 1);
  await alice.setViewport({ width: 1280, height: 1000 });
  console.log('PASS: registration validation, consent, stable identity, and explicit upload of existing local entries');

  const csrfBlocked = await alice.evaluate(async () => (await fetch('./api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"changes":[]}' })).status);
  assert.equal(csrfBlocked, 403);
  const cookieNames = await alice.cookies();
  assert.equal(cookieNames.find(cookie => cookie.name === 'little_log').httpOnly, true);

  const secondContext = await browser.createBrowserContext();
  const second = await secondContext.newPage();
  second.on('pageerror', error => errors.push(error.message));
  await second.goto(`${origin}/tracker/`, { waitUntil: 'networkidle0' });
  await signIn(second, 'alice', true);
  await settled(second, 1);
  assert.equal((await saved(second)).entries[0].liquidsMl, 400);
  await second.evaluate(() => navigator.serviceWorker.ready);
  await second.setOfflineMode(true);
  await second.click('[data-page="overview"]');
  await fill(second, '#liquids', 700);
  await second.evaluate(() => { crypto.getRandomValues = values => { values.fill(0); return values; }; }); // Keeps this queue-size assertion independent of an additional failure-deadline update.
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

  await alice.bringToFront(); // The SSO tab was active; foreground this device before interacting with its native date form.
  await alice.click('[data-page="overview"]');
  await fill(alice, '#wetting-category', 'semi-involuntary');
  await alice.click('#wetting-form button[type="submit"]');
  console.log('Wetting submitted on the first device');
  await settled(alice, 3);
  await second.bringToFront();
  await second.click('#sync-now');
  await settled(second, 3);
  assert.equal((await saved(second)).entries.find(entry => entry.kind === 'wetting').category, 'semi-involuntary');
  await second.click('[data-page="overview"]');
  assert.equal(await second.$eval('#protocol-probability', element => element.textContent), await alice.$eval('#protocol-probability', element => element.textContent));
  await alice.bringToFront();
  await alice.click('[data-page="settings"]');
  console.log('PASS: classified wettings and enrollment sync to the second device');

  const database = openDatabase(resolve(dataDirectory, 'little-log.sqlite'));
  const rows = database.exportRows();
  assert.equal(rows.length, 4);
  assert.equal(rows.filter(row => row.kind === 'protocol').length, 1);
  assert.equal(rows.find(row => row.kind === 'wetting').category, 'semi-involuntary');
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
