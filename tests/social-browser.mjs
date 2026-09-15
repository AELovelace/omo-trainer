import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import sharp from 'sharp';
import {openDatabase} from '../server/database.mjs';
import {navigateMenu} from './navigation-helper.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/social-browser-')),picture=resolve(directory,'picture.png');
await sharp({create:{width:80,height:60,channels:3,background:'#cf85ac'}}).png().toFile(picture);
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob'),cara=db.ensureParticipant('test','cara','Cara');
const relationship=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:relationship.id});let browser;const errors=[];
async function open(page,route){await page.bringToFront();await page.goto(origin+'/tracker/#'+route,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(route=>route==='feed'?!document.querySelector('#status-post').disabled:document.querySelector('#message-friend').options.length>1,{},route);}
async function click(page,selector){await page.$eval(selector,n=>n.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForFunction(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return !n.disabled&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{},selector);await page.click(selector);}
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const pages=[];
 for(const user of [alice,bob,cara]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,b,c]=pages;
 await open(a,'feed');assert.equal(await a.$eval('#status-audience',n=>n.value),'friends');await a.type('#status-text','Friends update <script>not HTML</script>');await (await a.$('#status-pictures')).uploadFile(picture);await a.waitForSelector('#status-picture-preview img');await a.type('#status-picture-preview input','Pink test picture');await click(a,'#status-post');await a.waitForFunction(()=>document.querySelector('#status-compose-status').textContent==='Status posted to Friends.');
 assert.equal(db.social.feed(bob.id).items.length,1);assert.equal(db.social.feed(cara.id).items.length,0);
 await open(b,'feed');await b.waitForSelector('#status-feed img');await b.$eval('#status-feed img',img=>img.decode());assert.equal(await b.$eval('#status-feed img',n=>n.alt),'Pink test picture');assert.equal(await b.$$eval('#status-feed script',nodes=>nodes.length),0);
 const privateImage=db.social.feed(bob.id).items[0].pictures[0].id;await open(c,'feed');assert.equal(await c.evaluate(async id=>(await fetch('./api/social/picture?id='+id)).status,privateImage),404);
 await open(a,'feed');await a.type('#status-text','Hello public feed');await a.select('#status-audience','public');await click(a,'#status-post');await a.waitForFunction(()=>document.querySelector('#status-compose-status').textContent==='Status posted to Public.');
 await open(c,'feed');await c.select('#feed-audience','public');await c.waitForFunction(()=>document.querySelector('#status-feed').textContent.includes('Hello public feed'));assert.ok(!await c.$eval('#status-feed',n=>n.textContent.includes('Friends update')));
 await a.bringToFront();await navigateMenu(a,'[data-page="social"]');await a.click('#social-friends');await a.waitForSelector('#friends-list .friend-row');await a.$$eval('#friends-list button',nodes=>nodes.find(n=>n.textContent==='Message').click());await a.waitForFunction(()=>location.hash==='#messages'&&!document.querySelector('#message-send').disabled);await a.type('#message-text','Hello Bob <b>literal text</b>');await click(a,'#message-send');await a.waitForFunction(()=>document.querySelector('#message-list').textContent.includes('Hello Bob'));
 assert.equal(db.social.conversations(bob.id)[0].unread,1);await open(b,'messages');assert.match(await b.$eval('#conversation-list',n=>n.textContent),/1 unread/);await b.select('#message-friend',alice.id);await b.waitForFunction(()=>document.querySelector('#message-list').textContent.includes('Hello Bob'));await b.waitForFunction(async()=>{const value=await (await fetch('./api/social/conversations')).json();return value.conversations[0].unread===0;});
 await b.waitForFunction(()=>!document.querySelector('#conversation-list').textContent.includes('unread'));assert.equal(await b.$$eval('#message-list b',nodes=>nodes.length),0);await b.type('#message-text','Hello Alice!');await click(b,'#message-send');await b.waitForFunction(()=>document.querySelector('#message-list').textContent.includes('Hello Alice!'));
 await open(a,'messages');await a.select('#message-friend',bob.id);await a.waitForFunction(()=>document.querySelector('#message-list').textContent.includes('Hello Alice!'));
 for(const theme of ['little-tracker','caregiver-tracker']){
  await a.evaluate(async theme=>{document.documentElement.dataset.theme=theme;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},theme);
  for(const width of [320,390,680,1024,1440]){await a.setViewport({width,height:950});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' messages overflow '+width);}
  await a.screenshot({path:resolve(directory,theme+'-messages-desktop.png'),fullPage:true});await a.setViewport({width:390,height:900});await a.screenshot({path:resolve(directory,theme+'-messages-mobile.png'),fullPage:true});
 }
 await navigateMenu(a,'[data-page="social"]');await a.waitForSelector('#status-feed img');for(const width of [320,390,1024]){await a.setViewport({width,height:950});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'feed overflow '+width);}await a.screenshot({path:resolve(directory,'feed.png'),fullPage:true});
 await a.evaluate(()=>navigator.serviceWorker.ready);assert.equal(await a.evaluate(async()=>{for(const key of await caches.keys()){const cache=await caches.open(key);if((await cache.keys()).some(r=>new URL(r.url).pathname.includes('/api/social/')))return true;}return false;}),false);
 await a.evaluate(()=>dispatchEvent(new Event('little-log-signout')));assert.equal(await a.$eval('#status-feed',n=>n.textContent),'');assert.equal(await a.$eval('#message-list',n=>n.textContent),'');assert.deepEqual(errors,[]);
 console.log('PASS: picture upload and previews, Friends/Public visibility, protected pictures, messages/replies/unread, safe text, responsive layouts and private cache cleanup. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
