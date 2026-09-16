import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/message-badge-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob');const f=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:f.id});
const send=id=>db.social.sendMessage(bob.id,{participantId:alice.id,requestId:id,body:'Private hello '+id});send('one');send('two');let browser;const errors=[];
async function badge(page,count){await page.waitForFunction(count=>[...document.querySelectorAll('[data-message-badge]')].every(n=>count?n.textContent===String(count)&&!n.hidden:n.hidden),{},count);} // Both bottom bars must reflect the same live unread count.
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(alice.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.goto(origin+'/tracker/#overview',{waitUntil:'networkidle0'});await badge(page,2);
 assert.deepEqual(await page.$$eval('.mobile-actions a',nodes=>nodes.map(n=>n.getAttribute('href'))),['#observation','#wetting','#change','#roll','#analysis','#messages']);assert.match(await page.$eval('#main-messages',n=>n.getAttribute('aria-label')),/2 unread messages/);
 for(const theme of ['little-tracker','caregiver-tracker']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const width of [320,390,680]){await page.setViewport({width,height:844,isMobile:true,hasTouch:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok(await page.$eval('#main-messages',n=>{const r=n.getBoundingClientRect();return r.bottom<=innerHeight&&r.width>=44;}));}await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.screenshot({path:resolve(directory,theme+'-badge.png')});}
 await page.click('#main-messages');await page.waitForFunction(()=>location.hash==='#messages'&&!document.querySelector('#message-refresh').disabled);await badge(page,2);assert.equal(db.social.unreadMessages(alice.id).unread,2);await page.click('#conversation-list .conversation-button');await page.waitForFunction(()=>document.querySelector('#message-list').textContent.includes('Private hello'));await badge(page,0);
 await page.evaluate(()=>location.hash='#overview');send('three');await badge(page,1); // Real polling must update the main bar without refreshing the page.
 await page.evaluate(()=>location.hash='#activity');await page.waitForFunction(()=>document.querySelector('#activity-list').textContent.includes('New message'));assert.ok(!await page.$eval('#activity-list',n=>n.textContent.includes('Private hello')));await page.$$eval('#activity-list button',nodes=>nodes.find(n=>n.textContent==='Open conversation').click());await page.waitForFunction(()=>location.hash==='#messages'&&document.querySelector('#message-list').textContent.includes('Private hello three'));await badge(page,0);
 await page.evaluate(()=>location.hash='#overview');send('four');await page.evaluate(()=>dispatchEvent(new Event('little-log-messages-updated')));await badge(page,1);await page.evaluate(()=>dispatchEvent(new Event('little-log-signout')));await badge(page,0);assert.deepEqual(errors,[]);
 console.log('PASS: sixth main shortcut, exact unread badges on both bars, mobile themes, count-only polling, read clearing, stored message links and sign-out cleanup. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
