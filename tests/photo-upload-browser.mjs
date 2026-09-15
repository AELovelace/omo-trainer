import assert from 'node:assert/strict';
import {mkdir,mkdtemp,stat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import sharp from 'sharp';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/photo-upload-')),photo=resolve(directory,'50mp-camera.jpg'),small=resolve(directory,'detailed-photo.png');
await sharp(randomBytes(8160*6120*3),{raw:{width:8160,height:6120,channels:3}}).jpeg({quality:95}).toFile(photo);
await sharp(randomBytes(512*512*3),{raw:{width:512,height:512,channels:3}}).png().toFile(small);
assert.ok((await stat(photo)).size>20*1024*1024); // A genuine 50 MP JPEG exceeds the old pre-resize limit.
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),user=db.ensureParticipant('test','camera','Camera user'),token=db.createSession(user.id);let browser;const errors=[],bodies=[];let rejected=0,loseResponse=true,signoutBeforeRejection=false;
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:token,url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(60000);
 await page.setRequestInterception(true);page.on('request',async request=>{try{
  if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/api/social/posts')){
   const body=request.postData();if(Buffer.byteLength(body)>256*1024){rejected++;if(signoutBeforeRejection)await page.evaluate(()=>dispatchEvent(new Event('little-log-signout')));await request.respond({status:413,contentType:'text/html',body:'<h1>Request Entity Too Large</h1>'});return;}
   bodies.push(body);if(loseResponse){loseResponse=false;const response=await fetch(request.url(),{method:'POST',headers:{Cookie:'little_log='+token,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':db.session(token).csrf},body});assert.equal(response.status,200);await response.json();await request.abort('failed');return;}
  }await request.continue();
 }catch(error){errors.push(error.message);await request.abort().catch(()=>{});}}); // Emulate the existing proxy and a lost response after the compact post commits.
 await page.goto(origin+'/tracker/#post',{waitUntil:'networkidle0'});await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>!document.querySelector('#status-post').disabled);
 await (await page.$('#status-pictures')).uploadFile(photo);await page.waitForFunction(()=>document.querySelector('#status-picture-preview img')&&!document.querySelector('#status-post').disabled);
 await page.$eval('#status-post',n=>n.click());await page.waitForFunction(()=>document.querySelector('#status-compose-status').textContent.includes('fetch')&&!document.querySelector('#status-post').disabled);
 assert.deepEqual(errors,[]);assert.equal(db.social.feed(user.id).items.length,1,JSON.stringify({rejected,bodies:bodies.length}));await page.$eval('#status-post',n=>n.click());await page.waitForFunction(()=>document.querySelector('#status-compose-status').textContent==='Status posted to Friends.');
 assert.equal(db.social.feed(user.id).items.length,1);assert.equal(rejected,1);assert.equal(bodies[0],bodies[1]);
 const uploaded=db.social.feed(user.id).items[0].pictures[0];assert.ok(uploaded.width<=1600&&uploaded.height<=1600);assert.equal((await sharp(db.social.photo(user.id,uploaded.id)).metadata()).format,'jpeg');
 await (await page.$('#status-pictures')).uploadFile(small,small,small,small);await page.waitForFunction(()=>document.querySelectorAll('#status-picture-preview img').length===4&&!document.querySelector('#status-post').disabled);
 await page.$eval('#status-text',n=>{n.value='\u6f22'.repeat(2000);n.dispatchEvent(new Event('input',{bubbles:true}));});await page.$$eval('#status-picture-preview input',nodes=>nodes.forEach(n=>{n.value='\u6f22'.repeat(200);n.dispatchEvent(new Event('input',{bubbles:true}));}));
 await page.$eval('#status-post',n=>n.click());await page.waitForFunction(()=>document.querySelector('#status-compose-status').textContent==='Status posted to Friends.'&&document.querySelectorAll('#status-picture-preview img').length===0);
 assert.equal(db.social.feed(user.id).items[0].pictures.length,4);assert.equal(rejected,2);assert.ok(Buffer.byteLength(bodies.at(-1))<256*1024);
 await page.evaluate(()=>location.hash='#settings');await page.waitForFunction(()=>!document.querySelector('#profile-file').disabled);await (await page.$('#profile-file')).uploadFile(small);await page.waitForFunction(()=>!document.querySelector('#profile-save').disabled);
 const compactAvatar=await page.$eval('#profile-preview img',img=>img.src.split(',')[1].length);assert.ok(compactAvatar<=Math.floor(128*1024/3)*4);
 await page.$eval('#profile-save',n=>n.click());await page.waitForFunction(()=>document.querySelector('#profile-status').textContent==='Profile picture saved.');assert.ok(db.social.profile(user.id).avatarVersion);
 // Files whose picker omits MIME metadata still resize, while undecodable pictures explain how to proceed.
 assert.equal(await page.evaluate(async()=>{const {preparePicture}=await import('./lib/picture-upload.js');const canvas=document.createElement('canvas');canvas.width=canvas.height=30;const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const value=await preparePicture(new File([blob],'camera.png',{type:''}));return Boolean(value.data);}),true);
 assert.equal(await page.evaluate(async()=>{const original=window.createImageBitmap;try{window.createImageBitmap=undefined;const {preparePicture}=await import('./lib/picture-upload.js');const canvas=document.createElement('canvas');canvas.width=canvas.height=10;const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));return Boolean((await preparePicture(blob)).data);}finally{window.createImageBitmap=original;}}),true);
 await page.evaluate(()=>location.hash='#post');await page.waitForFunction(()=>!document.querySelector('#status-post').disabled);await (await page.$('#status-pictures')).uploadFile(small,small,small,small);await page.waitForFunction(()=>document.querySelectorAll('#status-picture-preview img').length===4&&!document.querySelector('#status-post').disabled);signoutBeforeRejection=true;
 await page.$eval('#status-post',n=>n.click());await page.waitForFunction(()=>document.querySelector('#status-compose-status').textContent.includes('reopen Post'));assert.equal(db.social.feed(user.id).items.length,2);assert.equal(bodies.length,3); // Signing out while the first request is rejected must prevent any automatic retry.
 assert.deepEqual(errors,[]);console.log('PASS: 50 MP camera JPEG, automatic 256 KiB proxy fallback, retry after lost response without duplicate posts, four photos with maximum Unicode text, bounded avatars and missing MIME metadata. Fixture: '+directory);
}finally{await browser?.close();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
