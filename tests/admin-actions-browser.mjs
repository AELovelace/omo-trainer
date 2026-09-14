import assert from 'node:assert/strict';import {mkdir,mkdtemp} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {openDatabase} from '../server/database.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/admin-actions-'));
Object.assign(process.env,{DATA_DIR:directory,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',BASE_PATH:'/tracker/',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174'});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
const db=openDatabase(resolve(directory,'little-log.sqlite')),admin=db.ensureParticipant('test','admin','Admin'),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob');db.admin.bootstrap(admin.id);
for(const [i,category] of ['forced','semi-forced','voluntary','semi-involuntary','involuntary'].entries()){
 const id='wet-'+i,entry={id,kind:'wetting',occurredAt:'2026-09-0'+(i<3?1:i===3?2:4)+'T'+String(i*5).padStart(2,'0')+':00:00+14:00',category,position:'sitting',diaperNumber:1};db.sync(alice.id,[{id,mutationId:id,baseVersion:0,entry}]);
}
let browser;const errors=[];
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(admin.id),domain:'127.0.0.1',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:1440,height:1000});await page.goto(origin+'/tracker/admin/',{waitUntil:'networkidle0'});await page.waitForSelector('#graph-action-score svg');
 assert.equal(await page.$$eval('#graph-position-action .admin-legend-label',els=>els.length),5);assert.equal(await page.$$eval('#graph-position-action .admin-legend rect',els=>new Set(els.map(e=>e.getAttribute('fill'))).size),5);
 const ticks=await page.$$eval('#graph-action-score > svg > text',els=>els.filter(e=>e.getAttribute('text-anchor')==='end').map(e=>e.textContent));assert.deepEqual(ticks,['1','2','3','4','5']);
 assert.equal(await page.$$eval('#graph-action-score circle',els=>els.length),3);assert.equal(await page.$$eval('#graph-action-score polyline',els=>els.length),1,'Missing Sept 3 breaks the line');
 await page.select('#action-time-bin','3');assert.equal(await page.$$eval('#graph-time-action tbody tr',els=>els.length),8);await page.select('#action-time-bin','6');assert.equal(await page.$$eval('#graph-time-action tbody tr',els=>els.length),4);
 await page.select('#interval','month');assert.equal(await page.$$eval('#graph-action-score circle',els=>els.length),3,'Daily score ignores summary grouping');
 await page.select('#participant-filter',bob.id);assert.equal(await page.$$eval('#graph-action-score circle',els=>els.length),0);await page.select('#participant-filter',alice.id);assert.equal(await page.$$eval('#graph-action-score circle',els=>els.length),3);
 await page.$eval('#date-to',e=>{e.value='2026-09-02';e.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.$$eval('#graph-action-score circle',els=>els.length),2);await page.click('#all-dates');
 await page.$eval('#graph-action-score',e=>e.scrollIntoView());await page.screenshot({path:resolve(directory,'actions-desktop.png')});
 for(const width of [320,390,768,1440]){await page.setViewport({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.setViewport({width:390,height:900});await page.$eval('#graph-action-score',e=>e.scrollIntoView());await page.screenshot({path:resolve(directory,'actions-mobile.png')});
 assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(errors,[]);console.log('PASS: 5 action series, 3/6-hour bins, fixed 1-5 axis, daily gaps, participant/date filters and mobile layout. '+directory);
}finally{await browser?.close();db.close();await new Promise(r=>server.close(r));}
