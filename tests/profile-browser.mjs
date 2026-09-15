import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import sharp from 'sharp';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/profile-browser-')),picture=resolve(directory,'profile.png');
await sharp({create:{width:120,height:80,channels:3,background:'#cc88ad'}}).png().toFile(picture);
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob'),moderator=db.ensureParticipant('test','moderator','Moderator');db.admin.bootstrap(moderator.id);
const friendship=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:friendship.id});
const post=await db.social.publish(alice.id,{requestId:'seed',body:'An update',audience:'public'});db.social.comment(alice.id,{requestId:'comment',postId:post.id,body:'A comment'});db.social.sendMessage(alice.id,{requestId:'message',participantId:bob.id,body:'Hello Bob'});
let browser;const errors=[];
async function open(page,path){await page.bringToFront();await page.goto(origin+'/tracker/'+path,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});}
async function click(page,selector){await page.waitForSelector(selector,{visible:true});await page.$eval(selector,n=>n.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForFunction(selector=>{const n=document.querySelector(selector),r=n.getBoundingClientRect();return !n.disabled&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{},selector);await page.click(selector);}
async function uploaded(page){await page.waitForFunction(()=>!document.querySelector('#profile-file').disabled);await (await page.$('#profile-file')).uploadFile(picture);await page.waitForFunction(()=>!document.querySelector('#profile-save').disabled);await click(page,'#profile-save');await page.waitForFunction(()=>document.querySelector('#profile-status').textContent==='Profile picture saved.');}
async function decoded(page,selector){await page.waitForSelector(selector);await page.$eval(selector,n=>n.decode());}
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const pages=[];
 for(const user of [alice,bob,moderator]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,b,m]=pages;
 await open(a,'#settings');await uploaded(a);await decoded(a,'#profile-preview img');const first=db.social.profile(alice.id).avatarVersion;assert.ok(first);
 await uploaded(a);assert.notEqual(db.social.profile(alice.id).avatarVersion,first);a.once('dialog',dialog=>dialog.accept());await click(a,'#profile-remove');await a.waitForFunction(()=>document.querySelector('#profile-status').textContent==='Profile picture removed.');assert.equal(db.social.profile(alice.id).avatarVersion,null);assert.equal(await a.$('#profile-preview img'),null);
 await uploaded(a);await a.reload({waitUntil:'networkidle0'});await decoded(a,'#profile-preview img');
 for(const theme of ['little-tracker','caregiver-tracker']){await a.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const width of [320,390,1024]){await a.setViewport({width,height:900});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'profile settings '+theme+' '+width);}await a.setViewport({width:390,height:900});await a.$eval('#profile-title',n=>n.scrollIntoView());await a.screenshot({path:resolve(directory,theme+'-profile.png')});}
 await open(b,'#social');await decoded(b,'#status-feed .profile-avatar img');await click(b,'.social-comments summary');await decoded(b,'.social-comment .profile-avatar img');
 await click(b,'#social-friends');await b.waitForFunction(()=>location.hash==='#friends'&&document.querySelector('#social-friends').getAttribute('aria-current')==='page');await decoded(b,'#friends-list .profile-avatar img');await b.type('#friend-search-query','Alice');await click(b,'#friend-search-form button');await decoded(b,'#friend-search-results .profile-avatar img');
 for(const theme of ['little-tracker','caregiver-tracker']){await b.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const width of [320,390,1024]){await b.setViewport({width,height:900});assert.equal(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'friends '+theme+' '+width);}await b.setViewport({width:390,height:900});await b.screenshot({path:resolve(directory,theme+'-friends.png'),fullPage:true});}
 await click(b,'[data-social-page="messages"]');await decoded(b,'#conversation-list .profile-avatar img');await b.select('#message-friend',alice.id);await decoded(b,'#message-list .profile-avatar img');await b.waitForFunction(()=>!document.querySelector('#conversation-list').textContent.includes('unread'));await decoded(b,'#conversation-list .profile-avatar img');
 await open(m,'admin/#moderation');await m.select('#moderation-view','profiles');await decoded(m,'#moderation-list img');await m.type('#moderation-reason','Profile image review');m.once('dialog',dialog=>dialog.accept());await click(m,'#moderation-list button');await m.waitForFunction(()=>document.querySelector('#moderation-list').textContent.includes('Nothing to review'));assert.equal(db.social.profile(alice.id).avatarVersion,null);
 await open(b,'#feed');await b.waitForSelector('#status-feed .profile-avatar');assert.equal(await b.$('#status-feed .profile-avatar img'),null);
 await a.bringToFront();await click(a,'#profile-refresh');await a.waitForFunction(()=>!document.querySelector('#profile-file').disabled&&!document.querySelector('#profile-preview img'));await uploaded(a);
 await a.evaluate(()=>navigator.serviceWorker.ready);assert.equal(await a.evaluate(async()=>{for(const key of await caches.keys()){const cache=await caches.open(key);if((await cache.keys()).some(r=>new URL(r.url).pathname.includes('/api/social/')))return true;}return false;}),false);
 await a.evaluate(()=>dispatchEvent(new Event('little-log-signout')));assert.equal(await a.$eval('#profile-preview',n=>n.childElementCount),0);assert.equal(await a.$eval('#profile-file',n=>n.disabled),true);assert.deepEqual(errors,[]);
 console.log('PASS: upload/replace/remove/reload, avatars in feed/comments/friends/search/messages, six social tabs, both themes and phone layouts, admin removal, sign-out and private cache behavior. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
