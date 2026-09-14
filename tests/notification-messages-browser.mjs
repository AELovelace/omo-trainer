import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
const delivered=[];const db=openDatabase(':memory:',{stickerCatalog:[],notifications:{publicKey:'public',send:async(sub,payload)=>delivered.push({sub,payload}),random:()=>99}});
const admin=db.ensureParticipant('test','admin','Admin'),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');db.admin.bootstrap(admin.id);
const sub=id=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}});
for(const user of [a,b])db.notifications.save(user.id,{subscription:sub(user.id),timeZone:'UTC',quietStart:0,quietEnd:0,adminMessages:true});
const token=db.createSession(admin.id),login={origin:'',session:req=>db.session(req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('little_log='))?.slice(11))};
const api=createApi(db,login),root=resolve('.');
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/tracker/api/'))return api(req,res,url.pathname.slice('/tracker/api/'.length));
 const file=resolve(root,'.'+url.pathname.replace(/^\/tracker/,''),url.pathname.endsWith('/')?'index.html':'');
 if(!file.startsWith(root+'\\')&&!file.startsWith(root+'/')){res.writeHead(404);return res.end();}
 try{const content=await readFile(file);res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png'})[extname(file)]||'application/octet-stream'});res.end(content);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;let browser;
try{
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:token,url:login.origin+'/tracker/',path:'/tracker/',httpOnly:true});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:390,height:900});await page.goto(login.origin+'/tracker/admin/#notifications',{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.querySelector('#push-audience').textContent.includes('2 opted-in'));
 assert.equal(await page.$eval('.admin-filters',node=>node.hidden),true);assert.equal(await page.$eval('#push-send',node=>node.disabled),true);
 await page.select('#push-recipient',a.id);await page.type('#push-body','Hello <img src=x onerror=alert(1)>!');assert.equal(await page.$('#push-preview-body img'),null);assert.match(await page.$eval('#push-audience',node=>node.textContent),/^1 opted-in/);
 await page.click('#push-send');await page.waitForFunction(()=>document.querySelector('#push-status').textContent.startsWith('Notification queued'));
 await db.notifications.tick();assert.equal(delivered.length,1);assert.equal(delivered[0].sub.endpoint,sub(a.id).endpoint);assert.equal(delivered[0].payload.body,'Hello <img src=x onerror=alert(1)>!');
 await page.click('#push-reload');await page.waitForFunction(()=>document.querySelector('#push-history tbody td:nth-child(4)')?.textContent==='1');assert.equal(await page.$('#push-history img'),null);
 await page.select('#push-recipient','');await page.type('#push-body','Everyone gets a note.');await page.click('#push-send');await page.waitForSelector('#push-history button:not(:disabled)');await page.click('#push-history button');await page.waitForFunction(()=>document.querySelector('#push-status').textContent.includes('cancelled'));
 await db.notifications.tick();assert.equal(delivered.length,1,'Cancelled announcement must not send');
 // Losing a selected recipient never silently changes an individual message into a broadcast.
 await page.select('#push-recipient',b.id);db.notifications.remove(b.id,{all:true});await page.click('#push-reload');await page.waitForFunction(()=>document.querySelector('#push-audience').textContent.startsWith('0 opted-in'));assert.equal(await page.$eval('#push-recipient',node=>node.value),b.id);
 for(const width of [320,390,1024]){await page.setViewport({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.type('#push-body','Private draft');db.deleteSession(token);await page.click('#push-reload');await page.waitForSelector('#admin-gate:not([hidden])');assert.equal(await page.$eval('#push-body',node=>node.value),'');assert.equal(await page.$eval('#push-history',node=>node.childElementCount),0);
 assert.deepEqual(errors,[]);console.log('PASS: admin composer, explicit audience, literal preview, real queue and cancellation, mobile layout, and session-revocation cleanup (push transport mocked).');
}finally{await browser?.close();await new Promise(r=>server.close(r));db.close();}
