import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/desperation-mode-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(done=>server.once('listening',done));
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE||'C:/Users/langley/GameMakerProjects/lidollquest/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js').href)).default;
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
  const page=await browser.newPage(),errors=[],origin='http://127.0.0.1:'+server.address().port+'/tracker/';
  page.on('pageerror',error=>errors.push(error.message));await page.emulateTimezone('UTC');await page.setViewport({width:1280,height:1000});
  await page.evaluateOnNewDocument(()=>{
    const NativeDate=Date,now=()=>Number(sessionStorage.getItem('mode-clock')??NativeDate.parse('2026-09-14T12:00:00Z'));
    window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};
    crypto.getRandomValues=values=>{values.fill(99);return values;}; // Synthetic normal variation followed by Hold.
  });
  const saved=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')));
  const clock=time=>page.evaluate(time=>sessionStorage.setItem('mode-clock',String(Date.parse(time))),time);
  await page.goto(origin,{waitUntil:'networkidle0'});assert.equal(await page.$eval('#roll-desperation-mode',element=>element.checked),false);
  await page.click('#roll-desperation-mode');assert.match(await page.$eval('#roll-mode-preview',element=>element.textContent),/25%.*30 minutes/);
  await page.reload({waitUntil:'networkidle0'});assert.equal(await page.$eval('#roll-desperation-mode',element=>element.checked),true,'Mode preference survives reload');
  await page.click('.roll-button');const record=(await saved()).entries.find(entry=>entry.kind==='roll');
  assert.equal(record.probability,25);assert.equal(record.desperationMode,true);assert.equal(record.result,'hold');assert.equal(record.rollRuleVersion,3);
  assert.equal((await saved()).entries.find(entry=>entry.kind==='protocol').lastFailureDesperationMode,true);
  assert.match(await page.$eval('#roll-result',element=>element.textContent),/Desperation mode/);
  await page.waitForFunction(()=>document.querySelector('#cooldown-status').textContent.includes('30:00'));
  await page.click('#roll-desperation-mode');assert.equal((await saved()).settings.desperationMode,false);
  assert.equal(await page.$eval('.roll-button',element=>element.disabled),true,'Switching mode off cannot clear the timer');
  await page.goto(origin+'#history');await page.waitForSelector('[data-delete="'+record.id+'"]',{visible:true});
  assert.match(await page.$eval('#history-body',element=>element.textContent),/Desperation mode/);
  page.once('dialog',dialog=>dialog.accept());await page.click('[data-delete="'+record.id+'"]');
  assert.ok(!(await saved()).entries.some(entry=>entry.id===record.id));
  await page.goto(origin);await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  await page.setOfflineMode(true);await page.reload({waitUntil:'networkidle0'});
  await clock('2026-09-14T12:15:00Z');await page.waitForFunction(()=>document.querySelector('#cooldown-status').textContent.includes('15:00'));
  assert.equal(await page.$eval('.roll-button',element=>element.disabled),true,'Deleted mode roll remains blocked after offline reload and fifteen minutes');
  await clock('2026-09-14T12:29:59Z');await page.waitForFunction(()=>document.querySelector('#cooldown-status').textContent.includes('0:01'));
  assert.equal(await page.$eval('.roll-button',element=>element.disabled),true);
  await clock('2026-09-14T12:30:00Z');await page.waitForFunction(()=>!document.querySelector('.roll-button').disabled);
  await page.click('.roll-button');assert.equal((await saved()).entries.find(entry=>entry.kind==='roll').probability,50,'Subsequent normal roll uses full odds');
  assert.match(await page.$eval('#cooldown-status',element=>element.textContent),/15:00/);
  await page.screenshot({path:resolve(directory,'desktop.png'),fullPage:true});
  await page.setViewport({width:390,height:844});await page.click('.mobile-actions [data-action="roll"]');
  await page.waitForSelector('#roll-desperation-mode',{visible:true});await page.click('#roll-desperation-mode');
  assert.equal(await page.$eval('#roll-desperation-mode',element=>element.checked),true,'Mode remains selectable on the mobile roll page');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(directory,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('Desperation mode browser passed: selection/preview, saved mode, half odds, 30-minute deadline, deletion/offline protection and return to normal mode.');console.log('Screenshots:',directory);
}finally{await browser.close();await new Promise(done=>server.close(done));}
