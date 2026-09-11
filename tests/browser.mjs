import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const puppeteer = (await import(process.env.PUPPETEER_MODULE ? pathToFileURL(process.env.PUPPETEER_MODULE).href : 'puppeteer-core')).default;
const executablePath = process.env.CHROME_PATH; // Uses an installed browser so the test runner never downloads one implicitly.
if (!executablePath) throw new Error('Set CHROME_PATH to your Chrome or Chromium executable.');
const origin = process.env.TEST_URL ?? 'http://127.0.0.1:4173/tracker/';
const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const downloadDirectory = resolve(artifacts, `downloads-${Date.now()}`); // Isolates each run so a previous backup cannot satisfy download checks early.
await mkdir(downloadDirectory, { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true });
const errors = [];

async function fill(page, selector, value) { // Updates native controls and fires the same events the app listens for.
  await page.$eval(selector, (element, next) => {
    element.value = next;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
}

async function saved(page) { // Reads synthetic test records from the app's single storage namespace.
  return page.evaluate(() => JSON.parse(localStorage.getItem('lidoll.little-log.v1')));
}

try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.click('#crt-toggle');
  assert.equal(await page.$eval('#crt-toggle', element => element.getAttribute('aria-pressed')), 'false');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#crt-toggle', element => element.getAttribute('aria-pressed')), 'false', 'The display preference must survive reload');
  await page.click('#crt-toggle');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.waitForFunction(() => document.querySelector('#crt-toggle').disabled);
  assert.equal(await page.$eval('#crt-toggle', element => element.getAttribute('aria-pressed')), 'false');
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.waitForFunction(() => document.querySelector('#crt-toggle').getAttribute('aria-pressed') === 'true');
  await page.screenshot({ path: resolve(artifacts, 'desktop-empty.png'), fullPage: true });
  assert.equal(await page.$eval('#stat-rolls', element => element.textContent), '0');

  await fill(page, '#liquids', 250);
  await fill(page, '#wettings', 2);
  await fill(page, '#probability', 0);
  await page.click('.roll-button');
  assert.equal((await saved(page)).entries[0].result, 'hold');
  assert.equal((await saved(page)).entries[0].wettingsCount, 2);
  await page.click('#new-diaper');
  assert.equal(await page.$eval('#diaper', element => element.value), '2');
  assert.equal(await page.$eval('#wettings', element => element.value), '0');
  await fill(page, '#liquids', 600);
  await fill(page, '#probability', 100);
  await page.click('.roll-button');
  let state = await saved(page);
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[1].result, 'pee');
  assert.equal(state.entries[1].wettingsCount, 0);
  assert.equal(await page.$eval('#stat-liquids', element => element.textContent), '600');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#stat-rolls', element => element.textContent), '2');
  assert.equal(await page.$eval('#diaper', element => element.value), '2');

  const yesterday = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T12:00`;
  });
  await fill(page, '#occurred-at', yesterday);
  assert.equal(await page.$eval('#diaper', element => element.value), '1');
  assert.equal(await page.$eval('#liquids', element => element.value), '0');
  await fill(page, '#liquids', 400);
  await fill(page, '#probability', 37);
  await fill(page, '#manual-result', 'hold');
  await page.click('button[value="manual"]');
  state = await saved(page);
  assert.equal(state.entries[2].source, 'manual');
  assert.equal(state.entries[2].probability, 37);
  assert.equal(await page.$eval('#stat-rolls', element => element.textContent), '2');

  await page.click('[data-metric="liquids"]');
  assert.match(await page.$eval('#chart svg', element => element.getAttribute('aria-label')), /milliliters/);
  await fill(page, '#chart-days', 30);
  assert.equal(await page.$$eval('#chart-data tr', elements => elements.length), 30);
  await page.click('[data-page="history"]');
  assert.equal(await page.$$eval('#history-body tr', elements => elements.length), 3);
  await fill(page, '#filter-result', 'pee');
  assert.equal(await page.$$eval('#history-body tr', elements => elements.length), 1);
  await page.click('[data-edit]');
  await fill(page, '#edit-liquids', 650);
  await page.click('#edit-form button[type="submit"]');
  state = await saved(page);
  assert.equal(state.entries.find(entry => entry.result === 'pee').liquidsMl, 650);
  assert.equal(state.entries.find(entry => entry.result === 'pee').edited, true);
  await page.click('#clear-filters');

  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory });
  await page.click('#export-csv');
  await page.click('[data-page="settings"]');
  await page.click('#export-json');
  await page.waitForFunction(() => !document.querySelector('#page-settings').hidden);
  let downloads = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    downloads = await readdir(downloadDirectory);
    if (downloads.some(name => /^little-log-.*\.json$/.test(name)) && downloads.some(name => /^little-log-.*\.csv$/.test(name))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const backupPath = resolve(downloadDirectory, downloads.find(name => /^little-log-.*\.json$/.test(name)));
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.entries.length, 3);
  const csvPath = resolve(downloadDirectory, downloads.find(name => /^little-log-.*\.csv$/.test(name)));
  assert.match(await readFile(csvPath, 'utf8'), /"liquidsMl"/);
  await (await page.$('#import-file')).uploadFile(backupPath);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Imported 0'));
  assert.equal((await saved(page)).entries.length, 3);

  const badBackup = resolve(artifacts, 'invalid-backup.json');
  await writeFile(badBackup, JSON.stringify({ ...backup, entries: [{ ...backup.entries[0], position: '<img src=x onerror=alert(1)>' }] }));
  await (await page.$('#import-file')).uploadFile(badBackup);
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('supported position'));
  assert.equal((await saved(page)).entries.length, 3);

  await fill(page, '#default-probability', 25);
  await fill(page, '#default-position', 'standing');
  await page.click('#settings-form button');
  assert.equal((await saved(page)).settings.probability, 25);
  await page.click('[data-page="overview"]');
  assert.equal(await page.$eval('#probability', element => element.value), '25');

  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'networkidle0' });
  await page.screenshot({ path: resolve(artifacts, 'offline.png'), fullPage: true });
  assert.equal(await page.$eval('#stat-rolls', element => element.textContent), '2');
  await fill(page, '#probability', 100);
  await page.click('.roll-button');
  assert.equal((await saved(page)).entries.length, 4);
  await page.setOfflineMode(false);

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  for (const route of ['overview', 'history', 'settings']) {
    await page.click(`[data-page="${route}"]`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} must not overflow the phone viewport`);
  }
  await page.click('[data-page="overview"]');
  await page.screenshot({ path: resolve(artifacts, 'mobile.png'), fullPage: true });
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
  await page.screenshot({ path: resolve(artifacts, 'desktop.png'), fullPage: true });

  await page.click('[data-page="history"]');
  page.once('dialog', dialog => dialog.accept());
  await page.click('[data-delete]');
  assert.equal((await saved(page)).entries.length, 3);

  const before = await saved(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); }; });
  await page.click('[data-page="overview"]');
  await page.click('.roll-button');
  assert.deepEqual(await saved(page), before);
  assert.equal(await page.$eval('#storage-warning', element => element.hidden), false);
  await page.reload({ waitUntil: 'networkidle0' });

  await page.evaluate(() => localStorage.setItem('lidoll.little-log.v1', 'invalid JSON recovery test'));
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#storage-warning', element => element.hidden), false);
  await page.click('.roll-button');
  assert.equal(await page.evaluate(() => localStorage.getItem('lidoll.little-log.v1')), 'invalid JSON recovery test');
  await page.click('[data-page="settings"]');
  page.once('dialog', dialog => dialog.accept());
  await page.click('#delete-all');
  assert.equal(await saved(page), null);
  assert.equal(await page.$eval('#default-probability', element => element.value), '50');

  assert.deepEqual(errors, [], 'Browser should not raise JavaScript errors');
  console.log('Browser checks passed: logging, boundary rolls, daily defaults, edits, filters, charts, exports, imports, settings, offline reload/save, mobile layout, deletes, quota errors, and corrupt-data recovery.');
} finally { await browser.close(); }
