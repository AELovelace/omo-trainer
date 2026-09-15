import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/social-mobile-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob'),cara=db.ensureParticipant('test','cara','Cara');
for(const friend of [bob,cara]){const f=db.friends.act(alice.id,{action:'request',participantId:friend.id});db.friends.act(friend.id,{action:'accept',id:f.id});}
for(let i=0;i<8;i++)await db.social.publish(bob.id,{requestId:'post'+i,body:'A long update. '.repeat(50),audience:'public'});
for(let i=0;i<52;i++)db.social.sendMessage(bob.id,{requestId:'message'+i,participantId:alice.id,body:'Message '+i+' from Bob'});
db.social.sendMessage(cara.id,{requestId:'cara',participantId:alice.id,body:'Hello from Cara'});
let browser;const errors=[];
async function ready(page){await page.waitForFunction(()=>!document.querySelector('#message-refresh').disabled&&document.querySelector('#message-friend').options.length===3);}
async function openThread(page,id){await ready(page);await page.click(`[data-peer="${id}"] .conversation-button`);await page.waitForFunction(()=>document.querySelector('#page-messages').dataset.thread==='true'&&!document.querySelector('#message-refresh').disabled);}
async function shell(page){return page.evaluate(()=>{const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};return {top:rect('.topbar'),nav:rect('#social-navigation'),content:rect('#social-content'),scroll:document.scrollingElement.scrollTop,overflow:document.documentElement.scrollWidth>innerWidth,height:innerHeight};});} // Measure actual viewport placement instead of relying on CSS declarations.
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(alice.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await page.goto(origin+'/tracker/#feed',{waitUntil:'networkidle0'});await page.waitForSelector('#status-feed .status-card');
 for(const theme of ['little-tracker','caregiver-tracker']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const width of [320,390,680]){
   await page.setViewport({width,height:844,isMobile:true,hasTouch:true});const before=await shell(page);await page.$eval('#social-content',n=>n.scrollTop=n.scrollHeight);const after=await shell(page);
   assert.equal(after.overflow,false);assert.equal(after.scroll,0);assert.deepEqual(after.nav,before.nav);assert.deepEqual(after.top,before.top);assert.ok(Math.abs(after.nav.bottom-after.height)<2);assert.ok(after.content.height>600);assert.ok(await page.$eval('#social-content',n=>n.scrollTop>0));
  }
 }
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.$eval('#social-content',n=>n.scrollTop=0);const more='#status-feed .status-card .social-mobile-only';await page.click(more);assert.equal(await page.$eval(more,n=>n.getAttribute('aria-expanded')),'true');await page.screenshot({path:resolve(directory,'feed-mobile.png')});
 await page.click('[data-social-page="messages"]');await ready(page);assert.match(await page.$eval('#conversation-list',n=>n.textContent),/52 unread/);assert.equal(db.social.conversations(alice.id).find(c=>c.friend.id===bob.id).unread,52);
 await page.type('#message-search','Cara');assert.equal(await page.$$eval('#conversation-list .conversation-row',n=>n.length),1);await page.$eval('#message-search',n=>{n.value='';n.dispatchEvent(new Event('input'));});
 await openThread(page,bob.id);assert.equal(db.social.conversations(alice.id).find(c=>c.friend.id===bob.id).unread,0);assert.equal(await page.$eval('#message-list',n=>n.children.length),50);
 const pinned=await page.$eval('#message-form',n=>n.getBoundingClientRect().top);await page.$eval('#message-list',n=>n.scrollTop=0);assert.equal(await page.$eval('#message-form',n=>n.getBoundingClientRect().top),pinned);
 await page.click('#messages-older');await ready(page);assert.equal(await page.$eval('#message-list',n=>n.children.length),2);await page.click('#messages-newest');await ready(page);
 await page.type('#message-text','Unsent reply for Bob');await page.click('#message-back');await openThread(page,cara.id);assert.equal(await page.$eval('#message-text',n=>n.value),'');await page.type('#message-text','Draft for Cara');await page.click('#message-back');await openThread(page,bob.id);assert.equal(await page.$eval('#message-text',n=>n.value),'Unsent reply for Bob');
 await page.click('#message-back');db.social.sendMessage(bob.id,{requestId:'new-in-inbox',participantId:alice.id,body:'Unread while inbox is open'});await page.click('#message-refresh');await ready(page);assert.equal(db.social.conversations(alice.id).find(c=>c.friend.id===bob.id).unread,1);await page.select('#message-filter','unread');assert.equal(await page.$$eval('#conversation-list .conversation-row',n=>n.length),1);await page.select('#message-filter','inbox');
 await openThread(page,bob.id);await page.click('#message-archive');await page.waitForFunction(()=>document.querySelector('#page-messages').dataset.thread==='false');await ready(page);assert.equal(db.social.conversations(alice.id).find(c=>c.friend.id===bob.id).archived,true);assert.equal(db.social.conversations(bob.id)[0].archived,false);assert.equal(await page.$(`[data-peer="${bob.id}"]`),null);
 await page.select('#message-filter','archived');await openThread(page,bob.id);assert.equal(await page.$eval('#message-archive',n=>n.textContent),'Restore');await page.click('#message-archive');await ready(page);await page.select('#message-filter','all');await openThread(page,bob.id);
 await page.setViewport({width:390,height:460,isMobile:true,hasTouch:true});await page.focus('#message-text');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const short=await shell(page);assert.ok(Math.abs(short.nav.bottom-short.height)<2,JSON.stringify([short,await page.evaluate(()=>[...document.querySelectorAll('body,.app-shell,main,#page-social,#social-content,#page-messages,.message-workspace,.message-thread')].map(n=>[n.tagName,n.id,n.scrollTop,n.clientHeight,n.scrollHeight]))]));assert.ok(await page.$eval('#message-form',n=>n.getBoundingClientRect().bottom<=visualViewport.height));assert.ok(await page.$eval('#message-list',n=>n.clientHeight>70));await page.screenshot({path:resolve(directory,'thread-short-viewport.png')});
 await page.setViewport({width:1024,height:900,isMobile:true,hasTouch:true});await ready(page);assert.equal(await page.$eval('.inbox-tools',n=>getComputedStyle(n).display),'none');assert.equal(await page.$eval('.message-inbox',n=>getComputedStyle(n).display),'contents');assert.equal(await page.$eval('#social-content',n=>getComputedStyle(n).display),'contents');assert.notEqual(await page.evaluate(()=>getComputedStyle(document.documentElement).overflow),'hidden');assert.match(await page.$eval('#message-status',n=>n.textContent),/Private between/);
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await ready(page);await page.click('#message-back');await page.click('#message-new');await page.select('#message-friend',cara.id);await ready(page);assert.equal(await page.$eval('#message-text',n=>n.value),'Draft for Cara');
 await page.evaluate(()=>dispatchEvent(new Event('little-log-signout')));assert.equal(await page.$eval('#message-text',n=>n.value),'');assert.equal(await page.$eval('#message-peer',n=>n.textContent),'');assert.equal(await page.$eval('#conversation-list',n=>n.children.length),0);assert.deepEqual(errors,[]);
 console.log('PASS: mobile center scrolling, pinned navigation/reply, compact copy, inbox/search/folders, unread isolation, paging, drafts, archive/restore, short viewport, desktop layout and privacy cleanup. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
