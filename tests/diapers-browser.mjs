import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE||'C:/Users/langley/GameMakerProjects/lidollquest/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js').href)).default;
await mkdir('artifacts',{recursive:true});process.env.DATA_DIR=await mkdtemp(resolve('artifacts/overnight-diaper-'));process.env.PORT='0';process.env.HOST='127.0.0.1';
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}/tracker/`;
let browser;
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Users/langley/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateTimezone('UTC');await page.setViewport({width:390,height:844});
 await page.evaluateOnNewDocument(()=>{const NativeDate=Date;const now=()=>Number(sessionStorage.getItem('diaper-clock')??NativeDate.parse('2026-09-12T23:59:50Z'));window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[now()]));}static now(){return now();}};});
 await page.goto(origin+'#change');
 await page.evaluate(()=>localStorage.setItem('lidoll.little-log.v1',JSON.stringify({version:1,settings:{probability:50,position:'sitting'},entries:[
 {id:'change-evening',kind:'diaper-change',occurredAt:'2026-09-12T22:00:00+00:00',diaperNumber:6,wettingsCount:3},
 {id:'wet-night',kind:'wetting',occurredAt:'2026-09-12T23:00:00+00:00',diaperNumber:7,category:'voluntary',position:'sitting'}]})));
 await page.reload();await page.waitForFunction(()=>document.querySelector('#diaper-change-number').value==='7');
 assert.equal(await page.$eval('#diaper-change-wettings',e=>e.value),'1');
 await page.evaluate(()=>sessionStorage.setItem('diaper-clock',String(Date.parse('2026-09-13T00:01:00Z'))));
 await page.waitForFunction(()=>document.querySelector('#diaper-change-summary').textContent.includes('0 changes recorded on 2026-09-13'));
 assert.equal(await page.$eval('#diaper-change-number',e=>e.value),'7');assert.equal(await page.$eval('#diaper',e=>e.value),'7');assert.equal(await page.$eval('#diaper-change-wettings',e=>e.value),'1');
 await page.goto(origin+'#wetting');await page.select('#wetting-category','voluntary');await page.click('#wetting-form button[type="submit"]');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.filter(e=>e.kind==='wetting').length===2);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.filter(e=>e.kind==='wetting').at(-1).diaperNumber),7);
 await page.goto(origin+'#change');assert.equal(await page.$eval('#diaper-change-wettings',e=>e.value),'2');
 await page.reload();await page.waitForFunction(()=>document.querySelector('#diaper-change-wettings').value==='2');assert.equal(await page.$eval('#diaper-change-number',e=>e.value),'7');
 await page.evaluate(()=>sessionStorage.setItem('diaper-clock',String(Date.parse('2026-09-13T00:02:00Z'))));
 await page.click('#diaper-change-form button[type="submit"]');
 await page.waitForFunction(()=>document.querySelector('#diaper-change-number').value==='8');assert.equal(await page.$eval('#diaper-change-wettings',e=>e.value),'0');assert.match(await page.$eval('#diaper-change-summary',e=>e.textContent),/1 changes recorded/);
 const last=await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.filter(e=>e.kind==='diaper-change').at(-1));assert.equal(last.diaperNumber,7);assert.equal(last.wettingsCount,2);
 // Backdating the form before the morning change restores the diaper that was actually active then.
 await page.$eval('#diaper-change-time',e=>{e.value='2026-09-12T23:30';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});
 assert.equal(await page.$eval('#diaper-change-number',e=>e.value),'7');assert.equal(await page.$eval('#diaper-change-wettings',e=>e.value),'1');
 assert.deepEqual(errors,[]);console.log('PASS: mobile midnight rollover, overnight wetting save, reload, completed change and backdated form.');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
