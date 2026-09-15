import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile,readFile,access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { openAuthStore } from '../auth/store.mjs';
import { openDatabase } from '../server/database.mjs';
import { datasetCsv } from '../lib/admin-format.js';

const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
async function port() {
  const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done));
  const value=listener.address().port;await new Promise(done=>listener.close(done));return value;
}
await mkdir('artifacts',{recursive:true});
const directory=await mkdtemp(resolve('artifacts/admin-browser-')),origin='http://127.0.0.1:'+await port(),issuer='http://127.0.0.1:'+await port();
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:new URL(origin).port,PUBLIC_ORIGIN:origin,BASE_PATH:'/tracker/',OIDC_ISSUER:issuer,OIDC_CLIENT_ID:'little-log',
  DATA_DIR:resolve(directory,'tracker'),AUTH_HOST:'127.0.0.1',AUTH_PORT:new URL(issuer).port,AUTH_ISSUER:issuer,AUTH_DATA_DIR:resolve(directory,'auth'),AUTH_TRUST_PROXY:'0',TRACKER_REDIRECT_URI:origin+'/tracker/auth/callback'});
const store=openAuthStore(process.env.AUTH_DATA_DIR),password='synthetic-admin-test-password-123';
await store.setPassword('lid0ll',password,true);
await store.setPassword('alice',password,true);
const adminSubject=(await store.verify('lid0ll',password)).id,aliceSubject=(await store.verify('alice',password)).id;
store.close();
const {authServer}=await import('../scripts/auth-server.mjs');
const {server}=await import('../scripts/serve.mjs');
const db=openDatabase(resolve(process.env.DATA_DIR,'little-log.sqlite'));
const alice=db.ensureParticipant(issuer,aliceSubject,'Alice');
const now=new Date(),day=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);
const observation={id:'initial-observation',kind:'observation',occurredAt:day+'T08:00:00+00:00',liquidsMl:250,liquidsMode:'interval',diaperNumber:1,edited:false};
db.sync(alice.id,[{id:observation.id,mutationId:'seed',baseVersion:0,entry:observation}]);
db.saveGrowthChart(alice.id,{baseVersion:0,mutationId:'chart',chart:{name:'Alice',since:day,refusals:5,escaped:true,
  rows:[{id:'custom',label:'A custom line',note:'Meaning, with "quotes"',locked:false},{id:'potty',label:'Locked row',note:'',locked:true}],stars:{[day+':custom']:true}}});
const bootstrap=spawnSync(process.execPath,['scripts/bootstrap-admin.mjs','lid0ll'],{encoding:'utf8',env:process.env});
assert.equal(bootstrap.status,0,bootstrap.stderr);
const firstAdmin=JSON.parse(bootstrap.stdout.trim());
assert.equal(firstAdmin.role,'admin');
assert.equal(db.admin.users(firstAdmin.participantId).find(user=>user.id===firstAdmin.participantId).subject,adminSubject);
await access(firstAdmin.backup);
let browser;
const errors=[];
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
  const context=await browser.createBrowserContext(),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error' && message.text().includes('Content Security Policy'))errors.push(message.text());});
  await page.setViewport({width:1440,height:1000});
  await page.goto(origin+'/tracker/admin/',{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>!document.querySelector('#admin-gate').hidden);
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('#admin-gate a')]);
  await page.type('#username','lid0ll');await page.type('#password',password);
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('button[type="submit"]')]);
  if(page.url().startsWith(issuer))await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('button[type="submit"]')]);
  assert.equal(page.url(),origin+'/tracker/admin/');
  await page.waitForSelector('#graphs .admin-graph');
  assert.equal(await page.$$eval('#graphs .admin-graph',nodes=>nodes.length),23);
  assert.equal(await page.$$eval('#potty-graphs .admin-graph',nodes=>nodes.length),4);
  assert.match(await page.$eval('#chart-lines',node=>node.textContent),/A custom line/);
  assert.equal(await page.evaluate(()=>localStorage.length),0,'The admin console must not cache everyone’s data in localStorage');
  assert.deepEqual(await page.$$eval('#participant-filter option',nodes=>nodes.map(node=>node.value)),['',alice.id],'Only accounts with current tracking data are Participants');
  assert.equal(await page.$eval('#admin-summary article strong',node=>node.textContent),'1');
  assert.equal(await page.$eval('[data-inspect="'+firstAdmin.participantId+'"]',node=>node.disabled),true,'Empty accounts keep access controls but cannot open an unrelated cohort');

  // Change the actual participant chart after the admin's dataset has loaded, then verify fresh drilldown reads.
  const chartContext=await browser.createBrowserContext();
  await chartContext.setCookie({name:'little_log',value:db.createSession(alice.id),domain:'127.0.0.1',path:'/tracker/',httpOnly:true});
  const chartPage=await chartContext.newPage();
  await chartPage.goto(origin+'/tracker/potty_chart/',{waitUntil:'networkidle0'});
  await chartPage.waitForFunction(()=>document.querySelector('#chart-account-status').textContent.includes('Chart saved to your file.'));
  await chartPage.click('.row-tool:not(.row-tool-delete):not(.is-locked-tool)');
  await chartPage.$eval('.row-edit-label',node=>{node.value='A custom line updated';});
  await chartPage.click('.row-edit-save');
  await chartPage.click('#add-row');
  await chartPage.$eval('.row-edit-label',node=>{node.value='Added after admin opened';});
  await chartPage.$eval('.row-edit-note',node=>{node.value='The actual chart row description';});
  await chartPage.click('.row-edit-save');
  const added=await chartPage.evaluate(()=>JSON.parse(localStorage.getItem('ldq-growth-chart-v2')).rows.find(row=>row.label==='Added after admin opened').id);
  await chartPage.click('.star-cell[data-row="'+added+'"]:not(.is-future)');
  await chartPage.waitForFunction(()=>document.querySelector('#chart-account-status').textContent.includes('Chart saved to your file.'));
  const actual=await chartPage.evaluate(()=>{const {name,rows,stars,refusals,escaped,since}=JSON.parse(localStorage.getItem('ldq-growth-chart-v2'));return {name,rows,stars,refusals,escaped,since};});
  assert.deepEqual(db.growthChart(alice.id).chart,actual,'Participant UI edits must actually reach the database');
  await chartContext.close();
  await page.click('[data-tab="potty-charts"]');
  await page.waitForFunction(()=>!document.querySelector('[data-panel="potty-charts"]').hidden);
  assert.match(await page.$eval('#potty-summary',node=>node.textContent),/Linked charts/);
  await page.click('[data-chart-user="'+alice.id+'"]');
  await page.waitForFunction(()=>document.querySelector('#potty-detail').getAttribute('aria-busy')!=='true');
  assert.match(await page.$eval('#potty-detail-content',node=>node.textContent),/A custom line updated/);
  assert.match(await page.$eval('#potty-detail-content',node=>node.textContent),/Added after admin opened/);
  assert.match(await page.$eval('#potty-detail-content',node=>node.textContent),/The actual chart row description/);
  assert.match(await page.$eval('#potty-detail-content',node=>node.textContent),/Meaning, with "quotes"/);
  assert.match(await page.$eval('#potty-detail-content',node=>node.textContent),/A custom line/);
  assert.equal(await page.$$eval('.potty-grid .potty-star',nodes=>nodes.length),2);
  await page.click('[data-chart-week="-7"]');
  assert.equal(await page.$$eval('.potty-grid .potty-star',nodes=>nodes.length),0);
  assert.match(await page.$eval('.potty-row-details',node=>node.textContent),new RegExp(day));
  await page.click('[data-chart-week="7"]');
  assert.equal(await page.$$eval('.potty-grid .potty-star',nodes=>nodes.length),2);
  db.sync(firstAdmin.participantId,[{id:'first-admin-record',mutationId:'first-admin-record',baseVersion:0,entry:{...observation,id:'first-admin-record'}}]);
  await page.click('#refresh');await page.waitForFunction(id=>[...document.querySelector('#participant-filter').options].some(option=>option.value===id),{},firstAdmin.participantId);
  assert.equal(await page.$eval('#admin-summary article strong',node=>node.textContent),'2');
  await page.select('#participant-filter',firstAdmin.participantId);
  await page.waitForFunction(()=>document.querySelector('#potty-detail').getAttribute('aria-busy')!=='true');
  assert.match(await page.$eval('#potty-detail-content',node=>node.textContent),/no saved linked potty chart/);
  assert.doesNotMatch(await page.$eval('#potty-detail-content',node=>node.textContent),/A custom line/);
  db.sync(firstAdmin.participantId,[{id:'first-admin-record',mutationId:'delete-admin-record',baseVersion:1,entry:null}]);
  await page.click('#refresh');await page.waitForFunction(id=>![...document.querySelector('#participant-filter').options].some(option=>option.value===id),{},firstAdmin.participantId);
  assert.equal(await page.$eval('#participant-filter',node=>node.value),'','A removed selection returns to Everyone');
  assert.equal(await page.$eval('#admin-summary article strong',node=>node.textContent),'1');
  await page.select('#participant-filter',alice.id);
  await page.waitForFunction(()=>document.querySelector('#potty-detail').getAttribute('aria-busy')!=='true');
  assert.match(await page.$eval('#potty-detail-title',node=>node.textContent),/Alice/);
  await page.$eval('#date-from',node=>{node.value='2000-01-01';node.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.$eval('#date-to',node=>{node.value='2000-01-02';node.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.$$eval('#graph-stars svg[role="img"]',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('.potty-grid .potty-star',nodes=>nodes.length),2,'Drilldown retains history outside statistics dates');
  await page.click('#all-dates');
  const background=db.growthChart(alice.id);
  db.saveGrowthChart(alice.id,{baseVersion:background.version,mutationId:'background-chart-update',chart:{...background.chart,name:'Automatic admin refresh'}});
  await page.waitForFunction(()=>document.querySelector('#potty-detail-content').textContent.includes('Automatic admin refresh'),{timeout:22000});
  assert.match(await page.$eval('#admin-status',node=>node.textContent),/updated automatically/);
  for(const width of [320,390,768,1440]) {
    await page.setViewport({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Chart tab overflows at '+width);
    assert.equal(await page.$$eval('#potty-graphs .admin-legend',nodes=>nodes.filter(node=>node.textContent.trim()).length),4);
  }
  await page.screenshot({path:resolve(directory,'potty-charts-desktop.png'),fullPage:true});
  await page.setViewport({width:390,height:844});
  await page.$eval('#potty-detail',node=>node.scrollIntoView());
  await page.screenshot({path:resolve(directory,'potty-chart-phone.png')});
  await page.setViewport({width:1440,height:1000});
  await page.select('#participant-filter','');
  await page.click('[data-tab="analytics"]');
  const downloadDirectory=resolve(directory,'downloads');await mkdir(downloadDirectory);
  const cdp=await page.createCDPSession();await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDirectory,browserContextId:context.id}); // Downloads belong to the isolated signed-in test context.
  await page.click('[data-tab="transfer"]');
  for(const format of ['json','csv']) {
    await page.click('#export-'+format);
    await page.waitForFunction(()=>document.querySelector('#admin-status').textContent.startsWith('Exported '));
    const path=resolve(downloadDirectory,'little-log-everyone.'+format);
    for(let i=0;i<100;i++){try{await access(path);break;}catch{await new Promise(done=>setTimeout(done,50));}}
    const text=await readFile(path,'utf8');
    assert.match(text,/A custom line/);
    if(format==='json')assert.equal(JSON.parse(text).users.length,2);
  }
  await page.select('#participant-filter',alice.id);
  await page.click('#export-json');
  const individualPath=resolve(downloadDirectory,'little-log-'+alice.id+'.json');
  for(let i=0;i<100;i++){try{await access(individualPath);break;}catch{await new Promise(done=>setTimeout(done,50));}}
  assert.equal(JSON.parse(await readFile(individualPath,'utf8')).users.length,1);
  const transfer={format:'little-log-admin',schemaVersion:1,users:[{id:alice.id,label:'Alice',records:[{entry:{...observation,id:'csv-import',liquidsMl:350}}],growthChart:{chart:null}}]};
  const inputFile=resolve(directory,'import.csv');await writeFile(inputFile,datasetCsv(transfer));
  await (await page.$('#import-file')).uploadFile(inputFile);
  await page.click('#preview-import');
  await page.waitForFunction(()=>!document.querySelector('#apply-import').hidden);
  assert.equal(db.records(alice.id).length,1,'Preview must be read-only');
  await page.click('#apply-import');
  await page.waitForFunction(()=>document.querySelector('#admin-status').textContent.startsWith('Import complete:'));
  assert.equal(db.records(alice.id).length,2);

  await page.click('[data-tab="users"]');
  const userRow='tr[data-user="'+alice.id+'"]';
  await page.select(userRow+' [data-disabled]','true');await page.click(userRow+' [data-save-user]');
  await page.waitForFunction(()=>document.querySelector('#admin-status').textContent.includes('User access updated'));
  assert.throws(()=>db.createSession(alice.id),error=>error.status===403);
  await page.select(userRow+' [data-disabled]','false');await page.click(userRow+' [data-save-user]');
  await page.waitForFunction(()=>document.querySelector('#admin-status').textContent.includes('User access updated'));
  assert.equal(db.admin.access(alice.id).disabled,0);

  for(const width of [320,390,768,1440]) {
    await page.setViewport({width,height:1000});
    for(const route of ['analytics','potty-charts','users','transfer','audit']) {
      await page.click('[data-tab="'+route+'"]');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,route+' overflows at '+width);
    }
  }
  await page.click('[data-tab="analytics"]');
  await page.screenshot({path:resolve(directory,'analytics-desktop.png'),fullPage:true});
  await page.setViewport({width:390,height:844});
  await page.screenshot({path:resolve(directory,'analytics-phone.png')});
  await page.goto(origin+'/tracker/',{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>!document.querySelector('#admin-nav').hidden);
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('#admin-nav')]);
  await page.waitForSelector('#graphs .admin-graph');
  await page.evaluate(()=>navigator.serviceWorker.ready);
  assert.equal(await page.evaluate(async()=>{for(const key of await caches.keys()){for(const req of await (await caches.open(key)).keys())if(req.url.includes('/api/admin/'))return true;}return false;}),false);

  const ordinaryContext=await browser.createBrowserContext();
  await ordinaryContext.setCookie({name:'little_log',value:db.createSession(alice.id),domain:'127.0.0.1',path:'/tracker/',httpOnly:true});
  const ordinary=await ordinaryContext.newPage();
  await ordinary.goto(origin+'/tracker/admin/',{waitUntil:'networkidle0'});
  await ordinary.waitForFunction(()=>!document.querySelector('#admin-gate').hidden);
  assert.equal(await ordinary.$$eval('#graphs .admin-graph',nodes=>nodes.length),0,'Ordinary users must not receive shared analytics');
  assert.equal(await ordinary.evaluate(async()=> (await fetch('../api/admin/data')).status),403);
  assert.deepEqual(errors,[]);
  console.log('PASS: trusted lid0ll bootstrap + backup, real admin OAuth callback, 27 graphs, potty chart drilldown, cohort/individual exports, CSV preview/import, access controls, participant denial, private caching and four viewport widths.');
  console.log('Screenshots: '+directory);
}finally{
  if(browser)await browser.close();db.close();
  await Promise.all([new Promise(done=>server.close(done)),new Promise(done=>authServer.close(done))]);
}
