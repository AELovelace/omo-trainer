import assert from 'node:assert/strict';import {mkdir,mkdtemp,readFile} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {openDatabase} from '../server/database.mjs';import {parseCsv} from '../lib/admin-format.js';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/chart-builder-')),downloads=resolve(directory,'downloads');await mkdir(downloads);
Object.assign(process.env,{DATA_DIR:directory,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',BASE_PATH:'/tracker/',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174'});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
const db=openDatabase(resolve(directory,'little-log.sqlite')),admin=db.ensureParticipant('test','admin','Admin'),alice=db.ensureParticipant('test','alice','Alice'),bob=db.ensureParticipant('test','bob','Bob');db.admin.bootstrap(admin.id);
for(const user of [alice,bob])for(let day=1;day<=4;day++){
 const id=user.id+day,occurredAt='2026-09-0'+day+'T08:00:00+00:00';
 const entries=[{id:id+'o',kind:'observation',occurredAt,liquidsMl:day*100,liquidsMode:'interval',diaperNumber:1},...Array.from({length:day},(_,i)=>({id:id+'w'+i,kind:'wetting',occurredAt:'2026-09-0'+day+'T'+String(10+i).padStart(2,'0')+':00:00+00:00',category:'voluntary',position:'sitting',diaperNumber:1}))];
 db.sync(user.id,entries.map(entry=>({id:entry.id,mutationId:entry.id,baseVersion:0,entry})));
}
let browser;const errors=[];
const readDownload=async name=>{for(let i=0;i<100;i++){try{return await readFile(resolve(downloads,name));}catch{await new Promise(r=>setTimeout(r,50));}}throw Error('Download missing: '+name);};
try {
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});const context=await browser.createBrowserContext();await context.setCookie({name:'little_log',value:db.createSession(admin.id),domain:'127.0.0.1',path:'/tracker/',httpOnly:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Content Security Policy'))errors.push(m.text());});const cdp=await page.createCDPSession();await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
 await page.setViewport({width:1440,height:1100});await page.goto(origin+'/tracker/admin/',{waitUntil:'networkidle0'});await page.waitForSelector('#builder-plot svg');
 assert.equal(await page.$eval('#chart-builder',e=>e.getClientRects().length),0,'Builder is no longer displayed in Analytics');
 await page.click('[data-tab="advanced-drilldown"]');await page.waitForSelector('#chart-builder',{visible:true});
 assert.equal(await page.$eval('[data-panel="analytics"]',e=>e.hidden),true);
 assert.equal(await page.$eval('[data-tab="advanced-drilldown"]',e=>e.getAttribute('aria-current')),'page');
 const choose=async ids=>page.$$eval('#builder-metrics input[type="checkbox"]',(inputs,ids)=>{inputs.forEach(e=>{e.checked=ids.includes(e.value);});inputs[0].dispatchEvent(new Event('change',{bubbles:true}));},ids);
 await page.select('#participant-filter',alice.id);await choose(['wettings','liquids']);await page.select('#builder-x','liquids');await page.select('#builder-scale','normalized');assert.equal(await page.$$eval('#builder-plot circle',els=>els.length),8);
 await page.$eval('[data-color="wettings"]',e=>{e.value='#123456';e.dispatchEvent(new Event('change',{bubbles:true}));});assert.ok(await page.$eval('#builder-plot svg',e=>e.innerHTML.includes('#123456')));
 await page.click('[data-tab="analytics"]');await page.waitForSelector('#chart-builder',{hidden:true});
 await page.click('[data-tab="advanced-drilldown"]');await page.waitForSelector('#chart-builder',{visible:true});
 assert.equal(await page.$eval('#builder-x',e=>e.value),'liquids','Navigation preserves the chart setup');
 await page.type('#builder-preset-name','Intake comparison');await page.click('#builder-save');assert.match(await page.$eval('#builder-status',e=>e.textContent),/setup saved/);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('little-log.chart-presets.v1')));assert.deepEqual(saved[0].settings.y,['wettings','liquids']);assert.equal(JSON.stringify(saved).includes(alice.id),false);assert.equal(JSON.stringify(saved).includes('records'),false);
 await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#builder-plot svg',{visible:true});assert.equal(new URL(page.url()).hash,'#advanced-drilldown');await page.select('#builder-presets','Intake comparison');assert.equal(await page.$eval('#builder-x',e=>e.value),'liquids');assert.equal(await page.$eval('[data-color="wettings"]',e=>e.value),'#123456');
 await page.select('#participant-filter',alice.id);await page.$eval('.builder-picker',e=>e.open=false);
 await page.click('[data-builder-export="png"]');const png=await readDownload('little-log-custom-chart.png');assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),2200);assert.ok(png.readUInt32BE(20)>900);
 await page.click('[data-builder-export="svg"]');assert.match((await readDownload('little-log-custom-chart.svg')).toString(),/<svg/);
 await page.click('[data-builder-export="csv"]');const csv=(await readDownload('little-log-custom-chart.csv')).toString().replace(/^\uFEFF/,'');assert.equal(parseCsv(csv).length,4);assert.ok(csv.includes('400'));
 await page.click('[data-builder-export="json"]');const json=JSON.parse(await readDownload('little-log-custom-chart.json'));assert.equal(json.rows.length,4);assert.equal(json.rows[3].values.liquids,400);assert.equal(json.settings.scale,'normalized');
 await page.select('#builder-x','period');await page.select('#participant-filter','');await page.select('#builder-split','participant');assert.match(await page.$eval('#builder-status',e=>e.textContent),/6 colored lines/);
 for(const width of [320,390,768,1440]){await page.setViewport({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'overflow '+width);}
 await page.setViewport({width:1440,height:1000});await page.$eval('.builder-picker',e=>e.open=false);await page.$eval('#builder-plot',e=>e.scrollIntoView({block:'center'}));await page.screenshot({path:resolve(directory,'builder-desktop.png')});
 await page.setViewport({width:390,height:900});await page.$eval('#builder-plot',e=>e.scrollIntoView({block:'center'}));await page.screenshot({path:resolve(directory,'builder-mobile.png')});
 await choose([]);assert.match(await page.$eval('#builder-status',e=>e.textContent),/one and six/);assert.equal(await page.$eval('[data-builder-export="png"]',e=>e.disabled),true);await choose(['wettings']);
 db.admin.updateUser(admin.id,{id:admin.id,action:'revoke',version:1});await page.click('#refresh');await page.waitForFunction(()=>!document.querySelector('#admin-gate').hidden);assert.equal(await page.$$eval('#builder-plot svg',els=>els.length),0);assert.equal(await page.$eval('#builder-table',e=>e.textContent),'');
 assert.deepEqual(errors,[]);console.log('PASS: axis/metric/color selection, normalization, presets after reload, actual PNG/SVG/CSV/JSON downloads, per-participant lines, mobile layout and authorization cleanup. '+directory);
}finally{await browser?.close();db.close();await new Promise(r=>server.close(r));}
