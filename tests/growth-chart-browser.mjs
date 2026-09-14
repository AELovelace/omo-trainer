import {navigateMenu} from './navigation-helper.mjs';
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
  assert.equal(page.url(), origin + '/tracker/#potty-chart');
  await page.waitForFunction(() => !document.querySelector('#chart-sync').hidden);
}

try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, pipe: true });
  const context = await browser.createBrowserContext(), secondContext = await browser.createBrowserContext();
  const first = await context.newPage(), second = await secondContext.newPage();
  for (const page of [first, second]) { page.on('pageerror', error => errors.push(error.message)); await page.setViewport({ width: 390, height: 844 }); }
  await first.goto(origin + '/tracker/', { waitUntil: 'networkidle0' });
  await first.evaluate(()=>{window.integrationMarker='same-document';});
  await navigateMenu(first,'#growth-chart-nav');
  await first.waitForFunction(()=>!document.querySelector('#page-potty-chart').hidden);
  assert.equal(await first.evaluate(()=>window.integrationMarker),'same-document','Chart navigation must not reload Little Log');
  assert.equal(await first.$('iframe'),null);
  assert.equal(await first.$$eval('[id]',nodes=>nodes.length-new Set(nodes.map(node=>node.id)).size),0,'Integrated IDs must remain unique');
  assert.equal(await first.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Chart must fit a phone viewport');
  await fill(first, 'Device chart');
  await first.click('.star-cell:not(.is-locked):not(.is-future)');
  await first.click('.row-tool:not(.row-tool-delete):not(.is-locked-tool)');
  await first.$eval('.row-edit-label', element => { element.value = 'Morning routine'; });
  await first.$eval('.row-edit-note', element => { element.value = 'My own description for this line'; });
  await first.click('.row-edit-save'); // Rename a row after awarding a star to verify the stable ID keeps its association.
  await first.click('#add-row');
  await first.$eval('.row-edit-label', element => { element.value = 'Evening routine'; });
  await first.$eval('.row-edit-note', element => { element.value = 'A custom task before bed'; });
  await first.click('.row-edit-save');
  const customRow = (await saved(first)).rows.find(row => row.label === 'Evening routine');
  await first.click('.star-cell[data-row="' + customRow.id + '"]:not(.is-future)');
  await first.reload({ waitUntil: 'networkidle0' }); // Verify edited definitions survive the guest save before OAuth.
  const authored = await saved(first);

  const alice = db.ensureParticipant(issuer, aliceSubject, 'alice');
  assert.equal(db.growthChart(alice.id).chart, null, 'An anonymous chart stays local before sign-in');
  await first.click('.row-tool:not(.row-tool-delete):not(.is-locked-tool)');
  await first.$eval('.row-edit-note',node=>{node.value='Draft kept inside Little Log';});
  await navigateMenu(first,'[data-page="overview"]');
  await first.$eval('#liquids',node=>{node.value='123';node.dispatchEvent(new Event('input',{bubbles:true}));});
  await navigateMenu(first,'#growth-chart-nav');
  assert.equal(await first.$eval('.row-edit-note',node=>node.value),'Draft kept inside Little Log');
  await first.click('.row-edit-cancel');
  assert.equal(await first.$eval('#liquids',node=>node.value),'123');
  await signIn(first); await settled(first);
  assert.equal(await first.$('#chart-link'), null, 'Sign-in must link without an extra button');
  assert.equal((await saved(first)).name, 'Device chart');
  assert.equal(db.growthChart(alice.id).chart.name, 'Device chart');
  assert.equal(Object.keys(db.growthChart(alice.id).chart.stars).length, 2);
  assert.deepEqual(db.growthChart(alice.id).chart.rows, authored.rows, 'OAuth upload must include renamed and custom row labels and notes');
  assert.deepEqual(db.growthChart(alice.id).chart.stars, authored.stars);
  assert.equal((await saved(first)).sync.participant.id, alice.id);
  assert.equal((await first.evaluate(async () => (await (await fetch('./api/session')).json()).participant.id)), alice.id, 'Observations and chart share one participant');

  await second.goto(origin + '/tracker/#potty-chart', { waitUntil: 'networkidle0' });
  await signIn(second);
  await settled(second); // A fresh device automatically links and restores the existing file.
  assert.equal((await saved(second)).name, 'Device chart');
  assert.equal(Object.keys((await saved(second)).stars).length, 2);
  assert.deepEqual((await saved(second)).rows, authored.rows, 'A second device must restore each line definition, not substitute default labels');
  assert.deepEqual((await saved(second)).stars, authored.stars);

  await second.evaluate(() => localStorage.removeItem('ldq-growth-chart-v2'));
  await second.reload({ waitUntil: 'networkidle0' }); await settled(second);
  assert.equal((await saved(second)).name, 'Device chart', 'An existing app session must link and restore without signing in again');

  const sibling=await context.newPage();
  await sibling.goto(origin+'/tracker/#potty-chart',{waitUntil:'networkidle0'}); await settled(sibling);
  await first.bringToFront();
  await first.click('.row-tool:not(.row-tool-delete):not(.is-locked-tool)');
  await first.$eval('.row-edit-note',node=>{node.value='Unfinished editor draft';});
  await sibling.bringToFront();
  await fill(sibling,'Updated in another tab'); await settled(sibling);
  await first.bringToFront();
  await first.waitForFunction(()=>document.querySelector('#chart-name').value==='Updated in another tab');
  assert.equal(await first.$eval('.row-edit-note',node=>node.value),'Unfinished editor draft','Automatic pulls keep an unfinished row editor');
  await first.click('.row-edit-cancel');
  await sibling.bringToFront();
  await fill(sibling,'Device chart'); await settled(sibling);
  await first.bringToFront();
  await first.waitForFunction(()=>document.querySelector('#chart-name').value==='Device chart');
  await sibling.close();

  const thirdContext = await browser.createBrowserContext(), third = await thirdContext.newPage();
  third.on('pageerror', error => errors.push(error.message));
  await third.goto(origin + '/tracker/#potty-chart', { waitUntil: 'networkidle0' });
  await third.click('.row-tool:not(.row-tool-delete):not(.is-locked-tool)');
  await third.$eval('.row-edit-note', element => { element.value = 'Guest row note'; });
  await third.click('.row-edit-save'); // Custom rows alone are meaningful, even without a name or stars.
  const guestRows = (await saved(third)).rows, beforeConflict = db.growthChart(alice.id).version;
  await signIn(third);
  await settled(third);
  assert.equal((await saved(third)).sync.participant.id,alice.id);
  assert.ok((await saved(third)).rows.some(row=>row.note==='Guest row note'),'First link retains the guest row meaning');
  assert.ok((await saved(third)).rows.some(row=>row.label==='Morning routine'),'First link retains the saved account rows');
  assert.equal(Object.keys((await saved(third)).stars).length,2);
  assert.ok(db.growthChart(alice.id).version>beforeConflict);
  assert.equal(await third.$('#chart-conflict'),null,'Ordinary sync needs no whole-chart choice');
  await third.reload({waitUntil:'networkidle0'}); await settled(third);
  await thirdContext.close();

  await first.setOfflineMode(true); await fill(first, 'Offline chart');
  await first.goto(origin+'/tracker/potty_chart/',{waitUntil:'load'});
  assert.equal(first.url(),origin+'/tracker/#potty-chart','Old chart bookmarks resolve inside the offline PWA');
  assert.equal((await saved(first)).name, 'Offline chart');
  await fill(second, 'Second device'); await settled(second);
  await first.setOfflineMode(false);
  await settled(first);
  assert.equal((await saved(first)).name,'Offline chart','Pending local field edits automatically rebase over a newer file');
  assert.equal(db.growthChart(alice.id).chart.name,'Offline chart');

  let dropped = false, editDuringUpload = false, raceRemote=false;
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
      if(raceRemote && request.method()==='POST' && request.url().endsWith('/api/growth-chart')) {
        raceRemote=false; const current=db.growthChart(alice.id);
        db.saveGrowthChart(alice.id,{baseVersion:current.version,mutationId:'concurrent-server-save',chart:{...current.chart,refusals:current.chart.refusals+1}});
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
  await settled(first); // Lost responses retry automatically using the same mutation receipt.
  assert.equal(db.growthChart(alice.id).version, revision, 'Retrying the lost response must not create another revision');
  assert.equal(db.growthChart(alice.id).chart.name, 'Lost response');

  const beforeRace=db.growthChart(alice.id).chart.refusals;
  raceRemote=true;
  await fill(first,'Racing edit'); await settled(first);
  assert.equal(db.growthChart(alice.id).chart.name,'Racing edit');
  assert.equal(db.growthChart(alice.id).chart.refusals,beforeRace+1,'409 retry preserves the intervening server edit');

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
  const centralBeforeLogout=db.growthChart(alice.id);
  await navigateMenu(first,'[data-page="settings"]');
  first.once('dialog',dialog=>dialog.accept());
  await first.click('#disconnect-account');
  await first.waitForFunction(()=>JSON.parse(localStorage.getItem('ldq-growth-chart-v2')).sync===null);
  assert.equal((await saved(first)).name,'','Shared sign-out clears the integrated chart');
  assert.deepEqual(db.growthChart(alice.id),centralBeforeLogout,'Sign-out keeps the server chart');
  assert.deepEqual(errors, []);
  console.log('PASS: real OAuth callback, automatic linking, shared file identity, second-device restore, automatic guest/offline merge, lost-response retry, account isolation, clear and phone layout.');
} finally {
  if (browser) await browser.close();
  db.close();
  await Promise.all([new Promise(resolveClose => server.close(resolveClose)), new Promise(resolveClose => authServer.close(resolveClose))]);
}
