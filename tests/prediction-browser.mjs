import assert from 'node:assert/strict';import {mkdtemp,mkdir} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE||'C:/Users/langley/GameMakerProjects/lidollquest/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js').href)).default;
await mkdir('artifacts',{recursive:true});process.env.DATA_DIR=await mkdtemp(resolve('artifacts/prediction-browser-'));process.env.PORT='0';process.env.HOST='127.0.0.1';
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}/tracker/`;
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Users/langley/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',headless:true});
try {
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'#analysis');await page.waitForFunction(()=>document.querySelector('#prediction-status').textContent.includes('8 usable'));
 const entries=[];let id=0;const now=Date.now(),minute=60000;const stamp=t=>new Date(t).toISOString().replace(/\.\d{3}Z$/,'+00:00');
 for(let day=24;day>=0;day--){const end=now-day*86400000-5*minute,start=end-120*minute;entries.push({id:'p'+(++id),kind:'wetting',occurredAt:stamp(start),category:'voluntary',position:'sitting',diaperNumber:1},{id:'p'+(++id),kind:'wetting',occurredAt:stamp(end),category:'voluntary',position:'sitting',diaperNumber:1});}
 await page.evaluate(entries=>localStorage.setItem('lidoll.little-log.v1',JSON.stringify({version:1,settings:{probability:50,position:'sitting'},entries})),entries);await page.reload();await page.waitForFunction(()=>!document.querySelector('#prediction-result').hidden);
 assert.match(await page.$eval('#prediction-interval',el=>el.textContent),/120 min average/);assert.equal(await page.$$eval('#prediction-bars rect',els=>els.length),12);assert.equal(await page.$$eval('#prediction-data tr',els=>els.length),12);
 for(const width of [390,768,1440]){await page.setViewport({width,height:1000});assert.ok(await page.$eval('.prediction-card',el=>getComputedStyle(el).display!=='none'));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');}
 await page.setViewport({width:390,height:1000});await page.$eval('.prediction-card',el=>el.scrollIntoView());await page.screenshot({path:'artifacts/prediction-mobile.png',fullPage:true});
 await page.evaluate(async()=>{await navigator.serviceWorker.ready;});if(!await page.evaluate(()=>Boolean(navigator.serviceWorker.controller)))await page.reload();
 await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));await page.setOfflineMode(true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!document.querySelector('#prediction-result').hidden);assert.match(await page.$eval('#prediction-interval',el=>el.textContent),/120 min/);
 await page.setOfflineMode(false);
 // A wetting saved through the real form must retrain immediately, even from an offline-capable screen.
 await page.goto(origin+'#wetting');await page.select('#wetting-category','voluntary');await page.click('#wetting-form button[type="submit"]');await page.waitForFunction(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.filter(e=>e.kind==='wetting').length===51);await page.goto(origin+'#analysis');assert.ok(await page.$eval('#prediction-result',el=>!el.hidden));
 await page.evaluate(()=>localStorage.setItem('lidoll.little-log.v1',JSON.stringify({version:1,settings:{probability:50,position:'sitting'},entries:[]})));await page.reload();await page.waitForFunction(()=>document.querySelector('#prediction-result').hidden);assert.equal(await page.$$eval('#prediction-bars rect',els=>els.length),0);
 assert.deepEqual(errors,[]);console.log('PASS: empty history, personal forecast, mobile layouts, chart table, actual wetting save, cleared profile and offline PWA prediction.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
