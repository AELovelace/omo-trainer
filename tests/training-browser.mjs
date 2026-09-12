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
  await fill(page, '#liquids', '123');
  await page.click('.roll-card input[value="standing"]');
  await page.click('.roll-button');
  assert.equal(await page.$eval('#liquids', input => input.value), '123', 'Rolling preserves the unsaved observation');
  let state = await saved(page);
  assert.equal(state.entries.filter(entry => entry.kind === 'roll').length, 1);
  assert.equal(state.entries.find(entry => entry.kind === 'roll').probability, 50);
  assert.equal(state.entries.find(entry => entry.kind === 'roll').position, 'standing');
  assert.equal(state.entries.find(entry => entry.kind === 'roll').rolledAt, '2026-09-20T13:05:47+00:00');
  assert.equal(await page.$eval('.roll-button', button => button.disabled), true);
  await page.$eval('.roll-button', button => button.dispatchEvent(new Event('click')));
  assert.equal((await saved(page)).entries.length, 2, 'Programmatic submit cannot bypass the cooldown');
  for (const selector of ['#wetting-category', '#wetting-edit-category']) {
    assert.deepEqual(await page.$$eval(selector + ' option', options => options.filter(option => option.value).map(option => option.textContent)), ['Forced (F)', 'Semi-Forced (SF)', 'Voluntary (V)', 'Semi-involuntary (SI)', 'Involuntary (I)']);
  }
  await fill(page, '#wetting-category', 'semi-forced');
  await page.click('#wetting-form button[type="submit"]');
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'wetting').length, 1);
  assert.equal((await saved(page)).entries.find(entry => entry.kind === 'wetting').wettingsCount, undefined);
  assert.equal(await page.$('#wettings'), null, 'Per-diaper totals belong to the change card');
  assert.equal(await page.$eval('#diaper-change-wettings', input => input.value), '1');
  await fill(page, '#diaper-change-wettings', '3');
  await page.click('#diaper-change-form button[type="submit"]');
  assert.equal((await saved(page)).entries.find(entry => entry.kind === 'diaper-change').wettingsCount, 3);
  assert.equal(await page.$eval('#stat-diaper', element => element.textContent), '1');
  assert.equal(await page.$eval('#wetting-diaper', input => input.value), '2');
  assert.equal(await page.$eval('#diaper-change-wettings', input => input.value), '0');
  await page.click('#diaper-change-form button[type="submit"]');
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'diaper-change').length, 2);
  assert.equal(await page.$eval('#stat-diaper', element => element.textContent), '2');
  await fill(page, '#liquids', '250');
  await page.click('#save-observation');
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'roll').length, 1, 'Saving an observation must not create a roll');
  assert.equal((await saved(page)).entries.find(entry => entry.kind === 'observation').liquidsMl, 250);
  assert.equal(await page.$eval('#liquids', input => input.value), '0');
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
  assert.equal(await page.$eval('#stat-diaper', element => element.textContent), '0', 'Daily change count resets on the next day');
  await clock(page, '2026-09-22T00:00:00Z');
  await chance(page, 50);
  await fill(page, '#wetting-category', 'involuntary');
  await page.click('#wetting-form button[type="submit"]');
  await clock(page, '2026-09-23T00:00:00Z');
  await chance(page, 55);
  state = await saved(page);
  const first = state.entries.find(entry => entry.kind === 'wetting' && entry.category === 'semi-forced');
  await page.click('[data-page="history"]');
  assert.match(await page.$eval('#history-body', element => element.textContent), /Semi-Forced/);
  await page.click(`[data-edit="${first.id}"]`);
  assert.equal(await page.$eval('#wetting-edit-category', element => element.value), 'semi-forced');
  await fill(page, '#wetting-edit-category', 'involuntary');
  assert.equal(await page.$eval('#legacy-wetting-count', element => element.hidden), true);
  await page.click('#wetting-edit-form button[type="submit"]');
  await chance(page, 65);
  assert.equal((await saved(page)).entries.find(entry => entry.id === first.id).wettingsCount, undefined);
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
    for (const route of ['overview', 'history', 'settings', 'about']) {
      await page.click(`[data-page="${route}"]`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflows at ${width}px`);
    }
  }
  await page.click('[data-page="overview"]');
  await page.screenshot({ path: resolve('artifacts/protocol-desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });

  const actions = ['observation', 'wetting', 'change', 'roll', 'analysis'];
  const visiblePanels = () => page.$$eval('[data-mobile-panel]', panels => panels.filter(panel => panel.getClientRects().length).map(panel => panel.dataset.mobilePanel));
  const selectAction = async action => { // Use the fixed bar exactly as a phone visitor would.
    await page.click('.mobile-actions [data-action="' + action + '"]');
    await page.waitForFunction(value => document.querySelector('.mobile-actions [aria-current="page"]')?.dataset.action === value, {}, action);
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)))); // Let destination focus and scrolling finish before layout assertions.
  };
  await fill(page, '#liquids', '321');
  await selectAction('wetting');
  await fill(page, '#wetting-category', 'voluntary');
  await selectAction('change');
  await fill(page, '#diaper-change-wettings', '7');
  const entriesBeforeNavigation = (await saved(page)).entries.length;
  for (const width of [320, 390, 680]) {
    await page.setViewport({ width, height: 844 });
    for (const action of actions) {
      await selectAction(action);
      assert.deepEqual(await visiblePanels(), [action], 'Mobile actions show only the requested form or analysis');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Bottom actions must fit at ' + width);
      assert.equal(await page.$eval('.mobile-actions', bar => Math.abs(bar.getBoundingClientRect().bottom - innerHeight) < 1), true);
      assert.equal(await page.$$eval('.mobile-actions a', links => links.every(link => link.getBoundingClientRect().height >= 44)), true, 'Every action has a touch-sized target');
    }
  }
  await selectAction('change');
  assert.equal(await page.$eval('#diaper-change-wettings', input => input.value), '7', 'Switching keeps the change draft');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'diaper-change-title');
  await selectAction('observation');
  assert.equal(await page.$eval('#liquids', input => input.value), '321', 'Switching keeps the observation draft');
  await selectAction('wetting');
  assert.equal(await page.$eval('#wetting-category', input => input.value), 'voluntary', 'Switching keeps the wetting draft');
  await page.goBack(); await page.waitForFunction(() => location.hash === '#observation');
  assert.deepEqual(await visiblePanels(), ['observation']);
  await page.goForward(); await page.waitForFunction(() => location.hash === '#wetting');
  assert.deepEqual(await visiblePanels(), ['wetting']);
  assert.equal((await saved(page)).entries.length, entriesBeforeNavigation, 'Navigation must never save an observation, wetting or roll');
  await page.click('[data-page="settings"]');
  await page.waitForFunction(() => !document.querySelector('#page-settings').hidden);
  assert.equal(await page.$('.mobile-actions [aria-current]'), null);
  await selectAction('change');
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.deepEqual(await visiblePanels(), ['change'], 'Offline reopening retains the selected action');
  await page.setOfflineMode(false);
  await page.setViewport({ width: 1024, height: 1000 });
  assert.deepEqual(await visiblePanels(), actions, 'Desktop keeps all five dashboard cards');
  assert.equal(await page.$eval('.mobile-actions', bar => bar.getClientRects().length), 0);
  await page.setViewport({ width: 390, height: 844 });
  await selectAction('wetting');
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  assert.equal(await page.evaluate(() => document.querySelector('footer').getBoundingClientRect().bottom <= document.querySelector('.mobile-actions').getBoundingClientRect().top), true, 'The bar must leave the end of the page reachable');
  await selectAction('wetting'); // Tapping the current action returns to its heading.

  await page.screenshot({ path: resolve('artifacts/protocol-mobile.png'), fullPage: true });

  await selectAction('observation');
  await fill(page, '#liquids', '250');
  await page.click('#intake-unit-toggle');
  assert.equal(await page.$eval('#intake-unit-label', node => node.textContent), 'US fl oz');
  assert.equal(await page.$eval('#liquids', node => node.value), '8.45');
  await fill(page, '#liquids', '12.5');
  for (let i = 0; i < 3; i++) {
    await page.click('#intake-unit-toggle');
    assert.equal(await page.$eval('#liquids', node => node.value), '370');
    await page.click('#intake-unit-toggle');
    assert.equal(await page.$eval('#liquids', node => node.value), '12.5', 'Repeated unit switches retain the exact draft');
  }
  await page.click('#save-observation');
  const intakeEntries = (await saved(page)).entries.filter(entry => entry.kind === 'observation');
  assert.equal(intakeEntries.at(-1).liquidsMl, 370, 'Decimal US ounces save as the nearest whole milliliter');
  assert.equal(await page.$eval('#liquids', node => node.value), '0');
  assert.equal(await page.$eval('#intake-unit-label', node => node.textContent), 'US fl oz');
  await fill(page, '#liquids', '');
  await page.click('#intake-unit-toggle');
  assert.equal(await page.$eval('#liquids', node => node.value), '', 'Switching an empty field must not invent intake');
  await fill(page, '#liquids', '1000000');
  await page.click('#intake-unit-toggle'); await page.click('#intake-unit-toggle');
  assert.equal(await page.$eval('#liquids', node => node.value), '1000000', 'Maximum intake survives a round trip');
  await fill(page, '#liquids', '-1');
  assert.equal(await page.$eval('#liquids', node => node.checkValidity()), false);
  await fill(page, '#liquids', '0'); await page.click('#intake-unit-toggle');
  await page.setOfflineMode(true); await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#intake-unit-label', node => node.textContent), 'US fl oz', 'Unit preference survives an offline reload');
  assert.equal(await page.$eval('#liquids', node => node.value), '0');
  await page.setViewport({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Intake toggle fits a narrow phone');
  await page.screenshot({ path: resolve('artifacts/intake-unit-mobile.png') });
  await page.setOfflineMode(false);


  await page.click('[data-page="history"]');
  const completed = (await saved(page)).entries.find(entry => entry.kind === 'diaper-change');
  await page.click('[data-edit="' + completed.id + '"]');
  await fill(page, '#diaper-change-edit-wettings', '5');
  await page.click('#diaper-change-edit-form button[type="submit"]');
  assert.equal((await saved(page)).entries.find(entry => entry.id === completed.id).wettingsCount, 5);
  await page.select('#filter-result', 'diaper-change');
  assert.equal(await page.$$eval('#history-body tr', rows => rows.length), 2);
  page.once('dialog', dialog => dialog.accept());
  await page.click('[data-delete="' + completed.id + '"]');
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'diaper-change').length, 1);
  await selectAction('change');
  assert.deepEqual(await visiblePanels(), ['change']);
  await fill(page, '#diaper-change-wettings', '2');
  await page.click('#diaper-change-form button[type="submit"]');
  assert.equal((await saved(page)).entries.filter(entry => entry.kind === 'diaper-change').length, 2, 'Mobile Record change saves a completed diaper');
  await page.screenshot({ path: resolve('artifacts/diaper-change-mobile.png'), fullPage: true });

  assert.deepEqual(errors, []);
  console.log('Protocol browser checks passed: cooldown boundary, offline reload, manual and wetting logging, midnight rules, corrections, history and six viewport widths.');
} finally { await browser.close(); }
