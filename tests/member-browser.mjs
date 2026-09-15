import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/member-browser-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob'),cara=db.ensureParticipant('test','cara','Cara');
const friendship=db.friends.act(alice.id,{action:'request',participantId:bob.id});db.friends.act(bob.id,{action:'accept',id:friendship.id});
const privatePost=await db.social.publish(alice.id,{requestId:'private',body:'Alice friends post'}),publicPost=await db.social.publish(alice.id,{requestId:'public',body:'Alice public post',audience:'public'});await db.social.publish(bob.id,{requestId:'bob',body:'Bob public post',audience:'public'});db.social.comment(bob.id,{requestId:'comment',postId:publicPost.id,body:'Hello Alice'});db.social.sendMessage(alice.id,{participantId:bob.id,requestId:'message',body:'Hello Bob'});
let browser;const errors=[];
async function click(page,selector){await page.waitForSelector(selector,{visible:true});await page.$eval(selector,n=>n.scrollIntoView({block:'center',behavior:'instant'}));await page.click(selector);}
async function profile(page,label){await page.waitForFunction(label=>location.hash.startsWith('#profile')&&document.querySelector('#member-details h2')?.textContent===label,{},label);}
async function open(page,hash){await page.bringToFront();await page.goto(origin+'/tracker/#'+hash,{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});}
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const pages=[];
 for(const user of [alice,bob,cara]){const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:900});pages.push(page);}
 const [a,b,c]=pages;await open(a,'social');await click(a,'[data-social-page="profile"]');await profile(a,'Alice');assert.equal(await a.$$eval('#member-posts .status-card',nodes=>nodes.length),2);assert.equal(await a.$eval('#member-details a',n=>n.textContent),'Edit profile picture');
 await open(b,'feed?post='+publicPost.id);await click(b,'#status-feed .social-identity');await profile(b,'Alice');assert.equal(await b.$$eval('#member-posts .status-card',nodes=>nodes.length),2);assert.equal(await b.$eval('[data-social-page="profile"]',n=>n.getAttribute('aria-current')),'page');
 await click(b,'#member-posts .social-comments summary');await b.waitForSelector('#member-posts .social-comment .social-identity');await click(b,'#member-posts .social-comment .social-identity');await profile(b,'Bob');assert.equal(await b.$$eval('#member-posts .status-card',nodes=>nodes.length),1);
 await click(b,'#social-friends');await click(b,'#friends-list .social-identity');await profile(b,'Alice');await click(b,'#member-details button');await b.waitForFunction(()=>location.hash==='#messages'&&document.querySelector('#message-list .social-identity'));
 await click(b,'#message-list .social-identity');await profile(b,'Alice');await click(b,'[data-social-page="messages"]');await click(b,'#conversation-list .social-identity');await profile(b,'Alice');
 await open(c,'profile?id='+alice.id);await profile(c,'Alice');assert.equal(await c.$$eval('#member-posts .status-card',nodes=>nodes.length),1);assert.ok(!await c.$eval('#member-posts',n=>n.textContent.includes('friends post')));
 for(const theme of ['little-tracker','caregiver-tracker']){await c.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const width of [320,390,680,1024,1440]){await c.setViewport({width,height:900});assert.equal(await c.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' '+width);}await c.setViewport({width:390,height:900});await c.screenshot({path:resolve(directory,theme+'-profile.png'),fullPage:true});}
 await b.bringToFront();db.friends.act(alice.id,{action:'remove',id:friendship.id});await click(b,'#member-refresh');await b.waitForFunction(()=>document.querySelectorAll('#member-posts .status-card').length===1);assert.equal(await b.$('#member-details button'),null);
 await click(b,'[data-social-page="profile"]');await profile(b,'Bob');b.once('dialog',dialog=>dialog.accept());await b.$$eval('#member-posts button',nodes=>nodes.find(n=>n.textContent==='Delete post').click());await b.waitForFunction(()=>document.querySelectorAll('#member-posts .status-card').length===0);
 await open(c,'profile?id=missing');await c.waitForFunction(()=>document.querySelector('#member-status').textContent==='Profile not found.');assert.equal(await c.$eval('#member-details',n=>n.childElementCount),0);
 await c.evaluate(()=>location.hash='#profile');await profile(c,'Cara');await c.evaluate(()=>dispatchEvent(new Event('little-log-signout')));assert.equal(await c.$eval('#member-details',n=>n.childElementCount),0);assert.equal(await c.$eval('#member-posts',n=>n.childElementCount),0);assert.deepEqual(errors,[]);
 console.log('PASS: own Profile tab, author/comment/friend/message/conversation name links, private/public posts, friendship revocation, own deletion, missing/empty profiles, responsive themes and sign-out cleanup. Screenshots: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
