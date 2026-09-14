import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../server/database.mjs';

const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE||'C:/Users/langley/GameMakerProjects/lidollquest/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js').href)).default;
const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
await mkdir('artifacts',{recursive:true});process.env.DATA_DIR=await mkdtemp(resolve('artifacts/statistics-browser-'));
process.env.PORT=String(port);process.env.HOST='127.0.0.1';process.env.PUBLIC_ORIGIN='http://127.0.0.1:'+port;
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(done=>server.once('listening',done));
const base=process.env.PUBLIC_ORIGIN+'/tracker/',db=openDatabase(resolve(process.env.DATA_DIR,'little-log.sqlite'));
const admin=db.ensureParticipant('test','admin','Admin'),member=db.ensureParticipant('test','member','Member');db.admin.bootstrap(admin.id);
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
  const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(admin.id),domain:'127.0.0.1',path:'/tracker/',httpOnly:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1280,height:950});
  await page.goto(base+'admin/#statistics');await page.waitForFunction(()=>document.querySelector('#stats-url').textContent.includes('/statistics/v1/'));
  assert.equal(await page.$eval('.admin-filters',element=>element.hidden),true);
  await page.type('#stats-name','CrowPanel <safe>');await page.select('#stats-scope','all');await page.click('#stats-create');
  await page.waitForFunction(()=>document.querySelector('#stats-secret').value.startsWith('llstats_'));
  const token=await page.$eval('#stats-secret',element=>element.value),headers={Authorization:'Bearer '+token};
  const all=await fetch(base+'api/statistics/v1/summary?scope=all',{headers});assert.equal(all.status,200);assert.equal((await all.json()).registeredParticipants,2);
  const individual=await fetch(base+'api/statistics/v1/summary?scope=participant&participantId='+member.id,{headers});assert.equal((await individual.json()).participant.id,member.id);
  assert.equal(await page.$eval('#stats-list',element=>element.querySelector('safe')),null); // Device names remain literal text.
  await page.click('#stats-hide');assert.equal(await page.$eval('#stats-secret',element=>element.value),'');
  await page.click('#stats-list button');await page.waitForFunction(()=>document.querySelector('#stats-list').textContent.includes('Revoked'));
  assert.equal((await fetch(base+'api/statistics/v1/summary',{headers})).status,401);
  await page.screenshot({path:resolve(process.env.DATA_DIR,'desktop.png'),fullPage:true});
  await page.setViewport({width:390,height:844});await page.screenshot({path:resolve(process.env.DATA_DIR,'mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Device setup fits mobile');
  await page.click('#stats-create');await page.waitForFunction(()=>document.querySelector('#stats-secret').value.startsWith('llstats_'));
  db.admin.updateUser(admin.id,{id:member.id,action:'update',version:0,role:'admin',disabled:false});db.admin.updateUser(member.id,{id:admin.id,action:'update',version:1,role:'participant',disabled:false});
  await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#admin-workspace').hidden);
  assert.equal(await page.$eval('#stats-secret',element=>element.value),'');assert.deepEqual(errors,[]);
  console.log('Statistics browser passed: admin device creation, both views, safe labels, revoke/hide, mobile layout and access cleanup.');
  console.log('Screenshots:',process.env.DATA_DIR);
}finally{await browser.close();await new Promise(done=>server.close(done));db.close();}
