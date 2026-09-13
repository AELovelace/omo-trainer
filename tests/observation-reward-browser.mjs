import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/observation-reward-')),origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
let browser,server,db;const errors=[];
try {
 ({server}=await import('../scripts/serve.mjs'));if(!server.listening)await new Promise(r=>server.once('listening',r));
 db=openDatabase(resolve(directory,'little-log.sqlite'));const alice=db.ensureParticipant('issuer','alice','Alice');
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});const context=await browser.createBrowserContext();
 await context.setCookie({name:'little_log',value:db.createSession(alice.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true,sameSite:'Lax'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844});await page.evaluateOnNewDocument(()=>sessionStorage.setItem('little-log.connect','1'));await page.goto(origin+'/tracker/',{waitUntil:'networkidle0'});
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1'))?.sync.participant);
 const submit=()=>page.$eval('#log-form',form=>{form.querySelector('#liquids').value='100';form.requestSubmit();});
 await submit();await page.waitForFunction(()=>document.querySelector('#observation-reward-title').textContent==='You earned a sticker!');
 await page.waitForFunction(()=>document.querySelector('#observation-reward-image').naturalWidth>0);
 const entry=await page.evaluate(()=>JSON.parse(localStorage.getItem('lidoll.little-log.v1')).entries.find(e=>e.kind==='observation'));
 const reward=db.economy.recordReward(alice.id,entry.id);assert.equal(await page.$eval('#observation-reward-name',e=>e.textContent),reward.name);assert.equal(await page.$eval('#observation-reward-image',e=>e.getAttribute('src')),reward.url);
 assert.equal(await page.$eval('#toast',e=>e.hidden),true);assert.equal(await page.$eval('#observation-reward-dialog',e=>e.contains(document.activeElement)),true);
 await page.screenshot({path:resolve(directory,'earned-sticker-mobile.png')});
 for(const width of [320,390,1440]){await page.setViewport({width,height:844});assert.equal(await page.$eval('#observation-reward-dialog',e=>e.scrollWidth<=e.clientWidth),true);}
 await page.keyboard.press('Escape');assert.equal(await page.$eval('#observation-reward-dialog',e=>e.open),false);
 await page.setOfflineMode(true);await submit();await page.waitForFunction(()=>document.querySelector('#observation-reward-status').textContent.includes('reconnect and sync'));assert.equal(await page.$eval('#observation-reward-sticker',e=>e.hidden),true);
 await page.setOfflineMode(false);await page.$eval('#observation-reward-retry',button=>{if(!button.hidden&&!button.disabled)button.click();});await page.waitForFunction(()=>document.querySelector('#observation-reward-title').textContent==='You earned a sticker!');await page.click('#observation-reward-dialog .primary');
 // Dismissed offline saves do not reopen their dialog when a background sync finishes.
 await page.setOfflineMode(true);await submit();await page.keyboard.press('Escape');await page.setOfflineMode(false);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('lidoll.little-log.v1')).sync.queue.length);assert.equal(await page.$eval('#observation-reward-dialog',e=>e.open),false);
 const total=db.economy.snapshot(alice.id).types.reduce((n,t)=>n+t.quantity,0);assert.equal(total,3);
 const guest=await (await browser.createBrowserContext()).newPage();await guest.goto(origin+'/tracker/',{waitUntil:'networkidle0'});
 const unauthorized=await guest.evaluate(async id=>(await fetch('./api/record-reward?id='+id)).status,entry.id);assert.equal(unauthorized,401);
 await guest.$eval('#log-form',f=>{f.querySelector('#liquids').value='100';f.requestSubmit();});await guest.waitForFunction(()=>document.querySelector('#observation-reward-dialog').open);assert.match(await guest.$eval('#observation-reward-status',e=>e.textContent),/Sign in and sync/);assert.equal(await guest.$eval('#observation-reward-sticker',e=>e.hidden),true);
 assert.deepEqual(errors,[]);console.log('PASS: exact earned sticker, authenticated receipt, mobile sizing/focus/Escape, offline recovery, dismissed modal stays closed, and guest pending state. '+directory);
}finally{await browser?.close();db?.close();if(server)await new Promise(r=>server.close(r));}
