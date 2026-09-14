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
 assert.equal(await page.evaluate(()=>permissionRequests),0,'No notification permission prompt before opt-in');
 await page.click('#notification-enable');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.startsWith('Reminders enabled'));
 assert.equal(db.notifications.status(user.id).subscriptions,1);assert.equal(await page.evaluate(()=>permissionRequests),1);
 await page.select('#notification-quiet-start','23');await page.select('#notification-quiet-end','7');await page.click('#notification-save');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.includes('quiet hours saved'));
 assert.equal(db.notifications.status(user.id).preferences.quietStart,23);
 for(const width of [320,390,1024]){await page.setViewport({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.click('#notification-disable');await page.waitForFunction(()=>document.querySelector('#notification-status').textContent.includes('turned off'));
 assert.equal(db.notifications.status(user.id).subscriptions,0);assert.deepEqual(errors,[]);
 console.log('PASS: explicit permission, settings API, quiet hours, opt-out and mobile layout (push transport mocked).');
}finally{await browser?.close();db.close();await new Promise(r=>server.close(r));}
