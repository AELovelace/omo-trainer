import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/roll-variation-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;let browser;const errors=[];
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1280,height:1000});await page.goto('http://127.0.0.1:'+server.address().port+'/tracker/',{waitUntil:'networkidle0'});
 for(const [draws,modifier,probability,result]of [[[0],'guaranteed',100,'pee'],[[99,0],'none',50,'pee'],[[50,0],'increase',60,'pee'],[[25,99],'decrease',50,'hold']]) {
  await page.evaluate(draws=>{window.randomDraws=draws;crypto.getRandomValues=values=>{if(!randomDraws.length)throw Error('Unexpected random draw');values.fill(randomDraws.shift());return values;};},draws);
  await page.click('.roll-button');
  const record=await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.filter(e=>e.kind==='roll').at(-1));
  assert.equal(record.probability,probability);assert.equal(record.baseProbability,modifier==='decrease'?60:50);assert.equal(record.probabilityModifier,modifier);assert.equal(record.result,result);
  assert.equal(await page.$eval('#probability',e=>e.value),modifier==='increase'?'60':'50','Persistent adjustments update the daily base');
  assert.equal(await page.evaluate(()=>randomDraws.length),0);
 }
 const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries);
 assert.equal(await page.$eval('.roll-button',e=>e.disabled),true);
 await page.$eval('.roll-button',e=>e.dispatchEvent(new Event('click')));
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries),before);
 await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await page.setOfflineMode(true);await page.reload({waitUntil:'networkidle0'});
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries),before,'Offline reload preserves original draws');
 assert.equal(await page.$eval('.roll-button',e=>e.disabled),true);assert.equal(await page.$eval('#probability',e=>e.value),'50');
 assert.deepEqual(errors,[]);console.log('PASS: all roll variations, unchanged base, cooldown, persistence and offline reload.');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
