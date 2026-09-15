import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import webpush from 'web-push';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const keys=webpush.generateVAPIDKeys();
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/notifications-browser-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory,PUSH_VAPID_PUBLIC_KEY:keys.publicKey,PUSH_VAPID_PRIVATE_KEY:keys.privateKey,PUSH_VAPID_SUBJECT:'https://lidoll.dev'});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));
const db=openDatabase(resolve(directory,'little-log.sqlite')),user=db.ensureParticipant('test','reminders','Reminder tester');
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;let browser;
async function clickSetting(page,selector) {
 await page.$eval(selector,node=>node.scrollIntoView({block:'center',behavior:'instant'}));
 await page.waitForFunction(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return !node.disabled&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{},selector);
 await page.click(selector);
} // Center mobile controls away from the floating menu before clicking, matching a user's scroll into view.
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();await context.overridePermissions(origin,['notifications']);
 await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Browser push service access is stubbed; API writes and ownership checks use the actual server and database.
 await page.evaluateOnNewDocument(publicKey=>{
  window.permissionRequests=0;const original=Notification.requestPermission.bind(Notification);Notification.requestPermission=()=>{permissionRequests++;return original();};
  PushManager.prototype.getSubscription=async()=>window.testSubscription??null;
  PushManager.prototype.subscribe=async()=>window.testSubscription={endpoint:'https://fcm.googleapis.com/fcm/send/browser-fixture',toJSON(){return {endpoint:this.endpoint,keys:{p256dh:publicKey,auth:'AQEBAQEBAQEBAQEBAQEBAQ'}};},unsubscribe:async()=>{window.testSubscription=null;return true;}};
 },keys.publicKey);
 await page.setViewport({width:390,height:900});await page.goto(origin+'/tracker/#settings',{waitUntil:'networkidle0'});await page.waitForFunction(()=>!document.querySelector('#notification-enable').disabled);
 const artwork=await page.evaluate(async()=>{
  await navigator.serviceWorker.ready;
  const result={};
  for(const name of ['notification-icon.png','notification-badge.png']){
   const url=new URL('./icons/'+name,location.href),response=await fetch(url);if(!response.ok)throw Error('Notification icon is not served: '+name);
   const bitmap=await createImageBitmap(await response.blob()),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
   const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
   result[name]={width:bitmap.width,height:bitmap.height,corner:[...context.getImageData(0,0,1,1).data],center:[...context.getImageData(bitmap.width/2,bitmap.height/2,1,1).data],tip:[...context.getImageData(bitmap.width/2,8,1,1).data],cached:Boolean(await caches.match(url.href))};
  }return result;
 }); // Decode actual served PNGs and verify the notification badge retains transparent negative space offline.
 assert.equal(artwork['notification-icon.png'].width,192);assert.deepEqual(artwork['notification-icon.png'].corner,[255,245,250,255]);
 assert.equal(artwork['notification-badge.png'].width,96);assert.equal(artwork['notification-badge.png'].corner[3],0);assert.equal(artwork['notification-badge.png'].center[3],0);assert.deepEqual(artwork['notification-badge.png'].tip,[255,255,255,255]);
 assert.ok(Object.values(artwork).every(value=>value.cached));
 assert.equal(await page.evaluate(()=>permissionRequests),0,'No notification permission prompt before opt-in');
 await clickSetting(page,'#notification-enable');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.startsWith('Notifications enabled'));
 assert.equal(await page.$eval('#notification-title',node=>node.textContent),'Receive notifications');
 assert.equal(db.notifications.status(user.id).preferences.adminMessages,1);
 assert.equal(db.notifications.status(user.id).preferences.communitySupport,1);
 assert.equal(await page.$eval('#notification-community-support',node=>node.checked),true);
 assert.equal(await page.$eval('#notification-community-anonymous',node=>node.checked),false);
 assert.equal(db.notifications.status(user.id).preferences.communityAnonymous,0);
 assert.equal(db.notifications.status(user.id).subscriptions,1);assert.equal(await page.evaluate(()=>permissionRequests),1);
 await clickSetting(page,'#notification-admin-messages');
 await clickSetting(page,'#notification-community-support');
 await clickSetting(page,'#notification-community-anonymous');
 await page.select('#notification-quiet-start','23');await page.select('#notification-quiet-end','7');await clickSetting(page,'#notification-save');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.includes('quiet hours saved'));
 assert.equal(db.notifications.status(user.id).preferences.communitySupport,0);
 await page.reload({waitUntil:'networkidle0'});await page.waitForFunction(()=>!document.querySelector('#notification-enable').disabled);
 assert.equal(await page.$eval('#notification-community-support',node=>node.checked),false);
 assert.equal(await page.$eval('#notification-community-anonymous',node=>node.checked),true);
 await clickSetting(page,'#notification-enable');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.startsWith('Notifications enabled'));
 assert.equal(db.notifications.status(user.id).preferences.communitySupport,0,'Enabling another device preserves opt-out');
 assert.equal(db.notifications.status(user.id).preferences.communityAnonymous,1,'Enabling another device preserves anonymity');
 assert.equal(db.notifications.status(user.id).preferences.quietStart,23);assert.equal(db.notifications.status(user.id).preferences.adminMessages,0);
 for(const width of [320,390,1024]){await page.setViewport({width,height:900});const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);if(!fits){console.log('Overflow at',width,await page.$$eval('body *',nodes=>nodes.filter(node=>node.getBoundingClientRect().right>innerWidth+1&&!node.closest('[hidden]')).map(node=>[node.tagName,node.id,node.className,node.getBoundingClientRect().right]).slice(-20)));await page.screenshot({path:resolve(directory,'overflow.png'),fullPage:true});}assert.equal(fits,true);}
 await clickSetting(page,'#notification-disable');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.includes('turned off'));
 assert.equal(db.notifications.status(user.id).subscriptions,0);assert.deepEqual(errors,[]);
 console.log('PASS: explicit permission, settings API, quiet hours, opt-out and mobile layout (push transport mocked).');
}finally{await browser?.close();db.close();await new Promise(r=>server.close(r));}
