import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../server/database.mjs';
import {createLogin} from '../server/login.mjs';
import {createApi} from '../server/api.mjs';

const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE||'C:/Users/langley/GameMakerProjects/lidollquest/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js').href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/sessions-browser-'));
let now=Date.now(),login,api;const db=openDatabase(resolve(directory,'science.sqlite'),{sessions:{now:()=>now}});
const member=db.ensureParticipant('test','member','Remembered member'),token=db.createSession(member.id);
const server=createServer((request,response)=>{ // Only this synthetic fixture has a bootstrap route; production still signs in through OIDC.
  if(request.url==='/tracker/test-bootstrap'){
    login.session({headers:{cookie:'little_log='+token}},response);response.writeHead(200,{'Content-Type':'text/html'});response.end('<p>Synthetic sign-in completed.</p>');return;
  }
  void api(request,response,new URL(request.url,login.origin).pathname.slice('/tracker/api/'.length));
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
process.env.PUBLIC_ORIGIN=origin;login=createLogin(db,'/tracker/');api=createApi(db,login);
let browser;
const launch=()=>puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:resolve(directory,'browser-profile')});
try{
  browser=await launch();let page=await browser.newPage();await page.goto(origin+'/tracker/test-bootstrap');
  let saved=(await browser.cookies()).find(cookie=>cookie.name==='little_log');assert.ok(saved?.httpOnly&&saved.expires>Date.now()/1000+29*86400);
  assert.ok(!(await page.evaluate(()=>document.cookie)).includes(token),'Browser JavaScript must never read the credential');
  await browser.close();browser=null;now+=2*86400000;
  browser=await launch();page=await browser.newPage();const resumed=await page.goto(origin+'/tracker/api/session');assert.equal(resumed.status(),200);
  const session=JSON.parse(await page.$eval('body',element=>element.textContent));assert.equal(session.participant.id,member.id);
  assert.ok((await browser.cookies()).some(cookie=>cookie.name==='little_log'&&cookie.expires>Date.now()/1000+29*86400),'Reopened browser renews its persistent cookie');
  const status=await page.evaluate(async csrf=>(await fetch('/tracker/api/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'})).status,session.csrf);
  assert.equal(status,200);await browser.close();browser=null;
  browser=await launch();page=await browser.newPage();assert.equal((await page.goto(origin+'/tracker/api/session')).status(),401);
  assert.ok(!(await browser.cookies()).some(cookie=>cookie.name==='little_log'),'Logout persists across a second browser restart');
  console.log('Session browser passed: HttpOnly persistence across browser restart, two-day return, renewal and durable logout.');
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));db.close();}
