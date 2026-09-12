import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done));const port=listener.address().port;await new Promise(done=>listener.close(done));
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/coin-browser-')),origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
let browser,server,db;const errors=[];
try {
  ({server}=await import('../scripts/serve.mjs'));db=openDatabase(resolve(directory,'little-log.sqlite'));
  const admin=db.ensureParticipant('test','admin','Test admin');db.admin.bootstrap(admin.id);
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
  const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(admin.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true,sameSite:'Lax'});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const api=origin+'/tracker/api/lidollcoin/v1/';
  const post=(route,input,token)=>fetch(api+route+'?client_id=lidollquest',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(input)});
  const device=await (await post('device',{scope:'wallet:read wallet:write'})).json();
  await page.goto(device.verification_uri,{waitUntil:'networkidle0'});await page.waitForFunction(()=>!document.querySelector('#controls').hidden);
  await page.type('#user-code',device.user_code);await page.click('#code-form button');await page.waitForFunction(()=>!document.querySelector('#review').hidden);
  assert.equal(await page.$eval('#app-name',el=>el.textContent),'LiDollQuest');assert.match(await page.$eval('#permissions',el=>el.textContent),/earn and spend/);
  await page.click('#approve');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Approved'));
  const tokenResult=await (await post('token',{device_code:device.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'})).json();assert.ok(tokenResult.access_token);
  assert.equal((await (await post('operations',{request_id:'reward',kind:'credit',amount:50},tokenResult.access_token)).json()).balance,50);
  const purchase={request_id:'purchase',kind:'debit',amount:20};assert.equal((await (await post('operations',purchase,tokenResult.access_token)).json()).balance,30);
  assert.equal((await (await post('operations',purchase,tokenResult.access_token)).json()).balance,30);
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#connections button');
  for(const width of [320,390,680,1024]){await page.setViewport({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Connection page fits '+width);}
  await page.screenshot({path:resolve(directory,'connected-game.png')});
  await page.click('#connections button');await page.waitForFunction(()=>document.querySelector('#connections').textContent==='No connected apps.');
  assert.equal((await fetch(api+'wallet?client_id=lidollquest',{headers:{Authorization:'Bearer '+tokenResult.access_token}})).status,401);
  const guest=await browser.createBrowserContext(),signedOut=await guest.newPage();await signedOut.goto(device.verification_uri,{waitUntil:'networkidle0'});
  assert.equal(await signedOut.$eval('#controls',el=>el.hidden),true);assert.equal(await signedOut.$eval('#sign-in',el=>el.hidden),false);
  assert.deepEqual(errors,[]);console.log('Coin connection browser passed: consent, linking, shared earnings/spending, replay, revocation, signed-out gate and four widths. '+directory);
}finally{await browser?.close();db?.close();if(server)await new Promise(done=>server.close(done));}
