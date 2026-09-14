import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../server/database.mjs';
import {navigateMenu} from './navigation-helper.mjs';
import {createServer} from 'node:net';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/login-calendar-'));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:'http://127.0.0.1:'+port,BASE_PATH:'/tracker/',DATA_DIR:directory});
let server,db,browser;const errors=[];
try {
 ({server}=await import('../scripts/serve.mjs'));if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
 const origin='http://127.0.0.1:'+server.address().port;let clock=Date.now();
 db=openDatabase(resolve(directory,'little-log.sqlite'),{now:()=>clock});const user=db.ensureParticipant('test','alice','Alice');
 for(let ago=5;ago>=1;ago--) {clock=Date.now()-ago*86400000;const occurredAt=new Date(clock).toISOString().slice(0,19)+'+00:00',entry={id:'past-'+ago,kind:'wetting',occurredAt,category:'bedwetting',position:'laying-down',diaperNumber:1};db.sync(user.id,[{id:entry.id,entry,baseVersion:0,mutationId:entry.id}]);}
 clock=Date.now();
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true});const context=await browser.createBrowserContext();
 await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true,sameSite:'Lax'});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1440,height:1000});
 await page.evaluateOnNewDocument(()=>sessionStorage.setItem('little-log.connect','1'));await page.goto(origin+'/tracker/#login-bonuses',{waitUntil:'networkidle0'});
 await page.waitForFunction(()=>document.querySelector('#bonus-streak').textContent==='5');
 assert.match(await page.$eval('#bonus-next',node=>node.textContent),/3 diamonds/);
 assert.equal(await page.$$eval('#bonus-calendar button.checked',nodes=>nodes.length),5);
 assert.equal(await page.$eval('[data-page="login-bonuses"]',node=>node.getAttribute('aria-current')),'page');
 await page.select('#bonus-view','week');await page.waitForFunction(()=>document.querySelectorAll('#bonus-calendar button').length===7);
 await page.select('#bonus-view','month');await page.waitForFunction(()=>document.querySelectorAll('#bonus-calendar button').length>=28);
 await navigateMenu(page,'[data-page="overview"]');await page.select('#wetting-category','bedwetting');await page.click('#wetting-form button[type="submit"]');
 await page.waitForFunction(()=>document.querySelector('#observation-reward-title').textContent==='You earned a sticker!');await page.click('#observation-reward-dialog .primary');
 await navigateMenu(page,'[data-page="login-bonuses"]');await page.waitForFunction(()=>document.querySelector('#bonus-streak').textContent==='6');
 await page.click('#bonus-calendar [aria-current="date"]');assert.match(await page.$eval('#bonus-day-reward',node=>node.textContent),/3 diamonds paid/);
 assert.match(await page.$eval('#bonus-day-stats',node=>node.textContent),/Recorded events1/);
 await page.screenshot({path:resolve(directory,'calendar-desktop.png'),fullPage:true});
 for(const theme of ['little-tracker','caregiver-tracker'])for(const width of [320,390,1440]) {
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewport({width,height:950});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Calendar fits '+theme+' at '+width);
 }
 await page.setViewport({width:390,height:950});await page.screenshot({path:resolve(directory,'calendar-mobile.png'),fullPage:true});
 await navigateMenu(page,'[data-page="stickers"]');await page.waitForFunction(()=>document.querySelector('#economy-diamonds').textContent==='6');
 await page.$eval('#diamond-quantity',input=>{input.value='2';input.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.match(await page.$eval('#diamond-exchange-quote',node=>node.textContent),/100 coins/);await page.click('#diamond-exchange-submit');
 await page.waitForFunction(()=>document.querySelector('#economy-diamonds').textContent==='4'&&document.querySelector('#economy-coins').textContent==='160');
 const query=await page.evaluate(async()=>{const response=await fetch('./api/login-bonuses');return {cache:response.headers.get('cache-control'),data:await response.json()};});
 assert.equal(query.cache,'no-store');assert.equal(query.data.streak,6);assert.equal(query.data.earned.diamonds,6,'Exchanging diamonds does not erase earned rewards');
 assert.equal((await fetch(origin+'/tracker/api/login-bonuses')).status,401);
 assert.equal(await page.evaluate(async()=>(await fetch('./api/economy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'diamond-exchange',quantity:1,requestId:'csrf-test'})})).status),403);
 await navigateMenu(page,'[data-page="login-bonuses"]');await page.setOfflineMode(true);await page.click('#bonus-refresh');await page.waitForFunction(()=>document.querySelector('#bonus-content').hidden);await page.setOfflineMode(false);await page.click('#bonus-refresh');await page.waitForFunction(()=>!document.querySelector('#bonus-content').hidden);
 assert.deepEqual(errors,[]);console.log('PASS: calendar month/week, streak and daily stats, first-record bonus, diamond exchange, responsive themes, private API and offline recovery. '+directory);
} finally {await browser?.close();db?.close();if(server)await new Promise(resolve=>server.close(resolve));}
