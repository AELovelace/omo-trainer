import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
import {navigateMenu} from './navigation-helper.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/friends-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob <img src=x onerror=alert(1)>');
const entry={id:'shared-record',kind:'observation',occurredAt:'2026-09-15T12:00:00+00:00',liquidsMl:125,liquidsMode:'interval',diaperNumber:1};
db.sync(alice.id,[{id:entry.id,entry,baseVersion:0,mutationId:entry.id}]);let browser;const errors=[];
async function open(page,route='friends'){await page.bringToFront();await page.goto(origin+'/tracker/#'+route,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});if(route==='friends')await page.waitForFunction(()=>document.querySelector('#friends-status').textContent.startsWith('Share selected'));}
async function click(page,selector){await page.$eval(selector,n=>n.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForFunction(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return !n.disabled&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{},selector);await page.click(selector);}
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});
 const pages=[];
 for(const user of [alice,bob]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.evaluateOnNewDocument(()=>sessionStorage.setItem('little-log.connect','1'));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,b]=pages;
 await open(a);await a.type('#friend-search-query','Bob');await click(a,'#friend-search-form button');await a.waitForSelector('#friend-search-results button');
 assert.equal(await a.$$eval('#friend-search-results img',nodes=>nodes.length),0);await click(a,'#friend-search-results button');await a.waitForFunction(()=>document.querySelector('#friends-list').textContent.includes('Request sent'));
 await open(b);await b.waitForSelector('#friends-list button');assert.match(await b.$eval('#friends-list',n=>n.textContent),/Alice/);await click(b,'#friends-list button');await b.waitForFunction(()=>document.querySelector('#friends-list').textContent.includes('Remove friend'));
 await open(a,'history');await a.waitForSelector('[data-share-record="shared-record"]');await click(a,'[data-share-record="shared-record"]');
 await a.waitForFunction(()=>document.querySelector('#friend-share-preview').textContent.includes('125'));
 assert.equal(await a.$$eval('#friend-share-preview img',nodes=>nodes.length),0);await a.select('#friend-share-recipient',bob.id);await click(a,'#friend-share-send');await a.waitForFunction(()=>document.querySelector('#friend-share-status').textContent.startsWith('Record shared'));
 assert.equal(db.friends.shared(bob.id).items.length,1);
 await click(a,'#friend-share-close');await open(b);await b.waitForSelector('.friend-shared-card');assert.match(await b.$eval('#friend-shared-list',n=>n.textContent),/125/);
 assert.equal(await b.$$eval('#friend-shared-list button',nodes=>nodes.length),0,'Received records are read-only');
 for(const theme of ['little-tracker','caregiver-tracker']){
  await b.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const width of [320,390,680,1024,1440]){await b.setViewport({width,height:950});assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' overflow at '+width);}
  await b.screenshot({path:resolve(directory,theme+'-desktop.png'),fullPage:true});await b.setViewport({width:390,height:900});await b.screenshot({path:resolve(directory,theme+'-mobile.png'),fullPage:true});
 }
 await open(a);await a.select('#friend-shared-direction','outgoing');await a.waitForSelector('#friend-shared-list button');await click(a,'#friend-shared-list button');await a.waitForFunction(()=>document.querySelector('#friend-shared-list').textContent.includes('No shared records'));
 await open(b);assert.match(await b.$eval('#friend-shared-list',n=>n.textContent),/No shared records/);
 await navigateMenu(b,'[data-page="settings"]');await navigateMenu(b,'[data-page="friends"]');await b.waitForFunction(()=>document.querySelector('#friends-list').textContent.includes('Alice'));
 await b.evaluate(()=>navigator.serviceWorker.ready);await b.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await b.setOfflineMode(true);await b.evaluate(()=>dispatchEvent(new Event('offline')));assert.equal(await b.$eval('#friends-list',n=>n.textContent),'');
 assert.equal(await b.evaluate(async()=>{for(const name of await caches.keys()){const cache=await caches.open(name);for(const req of await cache.keys())if(new URL(req.url).pathname.includes('/api/friends'))return true;}return false;}),false);
 await b.setOfflineMode(false);await b.evaluate(()=>dispatchEvent(new Event('online')));await b.waitForFunction(()=>document.querySelector('#friends-list').textContent.includes('Alice'));
 await b.evaluate(()=>dispatchEvent(new Event('little-log-signout')));assert.equal(await b.$eval('#friends-list',n=>n.textContent),'');assert.deepEqual(errors,[]);
 console.log('PASS: friend search/request/accept, record preview/share/read/revoke, safe labels, both themes, five widths, navigation and private cache cleanup. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
