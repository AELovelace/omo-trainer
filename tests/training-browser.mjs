import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const puppeteer = (await import(process.env.PUPPETEER_MODULE ? pathToFileURL(process.env.PUPPETEER_MODULE).href : 'puppeteer-core')).default;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const origin = process.env.TEST_URL ?? 'http://127.0.0.1:4173/tracker/';
const errors = [];
await mkdir('artifacts', { recursive: true });

async function fill(page, selector, value) { // Exercises native validation and form events with synthetic observations.
  await page.$eval(selector, (input, next) => { input.value = next; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
}
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('lidoll.little-log.v1')));
const clock = (page, timestamp) => page.evaluate(value => sessionStorage.setItem('test-clock', value), String(Date.parse(timestamp)));
async function chance(page, expected) { // Waits for the real app's midnight refresh rather than calling its calculation functions directly.
  await page.waitForFunction(value => document.querySelector('#protocol-probability').textContent === `${value}%`, {}, expected);
}

try {
  const page = await browser.newPage();
  await page.emulateTimezone('UTC');
  await page.evaluateOnNewDocument(() => { // A controlled browser clock tests exact deadlines without a ten-minute real-time wait.
    const NativeDate = Date;
    const now = () => Number(sessionStorage.getItem('test-clock') ?? NativeDate.parse('2026-09-20T13:05:47Z'));
    window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
    crypto.getRandomValues = values => { values.fill(99); return values; }; // Deterministic failed draws; this override exists only in the isolated test browser.
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.click('.roll-button');
  let state = await saved(page);
  assert.equal(state.entries.filter(entry => !entry.kind).length, 1);
  assert.equal(state.entries.find(entry => !entry.kind).probability, 50);
  assert.equal(state.entries.find(entry => !entry.kind).rolledAt, '2026-09-20T13:05:47+00:00');
  assert.equal(await page.$eval('.roll-button', button => button.disabled), true);
  await page.$eval('#log-form', form => form.requestSubmit(document.querySelector('.roll-button')));
  assert.equal((await saved(page)).entries.length, 2, 'Programmatic submit cannot bypass the cooldown');
  await fill(page, '#wetting-category', 'forced');
  await page.click('#wetting-form button[type="submit"]');
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'wetting').length, 1);
  await page.click('button[value="manual"]');
  assert.equal((await saved(page)).entries.filter(entry => !entry.kind).length, 2, 'Manual logging stays available');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('.roll-button', button => button.disabled), true, 'Offline reload retains the deadline');
  await clock(page, '2026-09-20T13:15:46Z');
  await page.waitForFunction(() => document.querySelector('#cooldown-status').textContent.includes('0:01'));
  assert.equal(await page.$eval('.roll-button', button => button.disabled), true);
  await clock(page, '2026-09-20T13:15:47Z');
  await page.waitForFunction(() => !document.querySelector('.roll-button').disabled);
  await clock(page, '2026-09-21T00:00:00Z');
  await chance(page, 45);
  await clock(page, '2026-09-22T00:00:00Z');
  await chance(page, 50);
  await fill(page, '#wetting-category', 'involuntary');
  await page.click('#wetting-form button[type="submit"]');
  await clock(page, '2026-09-23T00:00:00Z');
  await chance(page, 55);
  state = await saved(page);
  const first = state.entries.find(entry => entry.kind === 'wetting' && entry.category === 'forced');
  await page.click('[data-page="history"]');
  await page.click(`[data-edit="${first.id}"]`);
  await fill(page, '#wetting-edit-category', 'involuntary');
  await page.click('#wetting-edit-form button[type="submit"]');
  await chance(page, 65);
  assert.equal((await saved(page)).entries.find(entry => entry.rolledAt).probability, 50, 'Corrections must not rewrite historical roll probabilities');
  await fill(page, '#filter-result', 'wetting');
  await page.$eval('#filter-result', input => input.dispatchEvent(new Event('change', { bubbles: true })));
  assert.equal(await page.$$eval('#history-body tr', rows => rows.length), 2);
  page.once('dialog', dialog => dialog.accept());
  await page.click(`[data-delete="${first.id}"]`);
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'wetting').length, 1);
  await page.setOfflineMode(false);
  await page.click('[data-page="overview"]');
  await page.click('.roll-button');
  const failed = (await saved(page)).entries.filter(entry => entry.rolledAt).at(-1);
  await page.click('[data-page="history"]');
  await page.click('#clear-filters');
  page.once('dialog', dialog => dialog.accept());
  await page.click(`[data-delete="${failed.id}"]`);
  assert.equal(await page.$eval('.roll-button', button => button.disabled), true, 'Deleting a failure cannot bypass its saved deadline');
  for (const width of [320, 390, 680, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    for (const route of ['overview', 'history', 'settings']) {
      await page.click(`[data-page="${route}"]`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflows at ${width}px`);
    }
  }
  await page.click('[data-page="overview"]');
  await page.screenshot({ path: resolve('artifacts/protocol-desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('artifacts/protocol-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Protocol browser checks passed: cooldown boundary, offline reload, manual and wetting logging, midnight rules, corrections, history and six viewport widths.');
} finally { await browser.close(); }
