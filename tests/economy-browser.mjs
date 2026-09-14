import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {openDatabase} from '../server/database.mjs';
import {stickerCatalog} from '../server/sticker-catalog.mjs';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
const listener=createServer();await new Promise(done=>listener.listen(0,'127.0.0.1',done));const port=listener.address().port;await new Promise(done=>listener.close(done));
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/economy-browser-'));
const origin='http://127.0.0.1:'+port;
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),BASE_PATH:'/tracker/',PUBLIC_ORIGIN:origin,OIDC_ISSUER:'http://127.0.0.1:4174',DATA_DIR:directory});
let browser,server,db;const errors=[];
try {
  ({server}=await import('../scripts/serve.mjs'));
  const type=stickerCatalog()[0];
  db=openDatabase(resolve(directory,'little-log.sqlite'),{stickerCatalog:[type]});
  const alice=db.ensureParticipant('issuer','a','Alice'),bob=db.ensureParticipant('issuer','b','Bob');
  for(const user of [alice,bob])for(let i=0;i<3;i++) {
    const entry={id:'entry-'+i,kind:'observation',occurredAt:'2026-09-12T12:00:00+00:00',liquidsMl:100,liquidsMode:'interval',diaperNumber:1};
    db.sync(user.id,[{id:entry.id,mutationId:entry.id,baseVersion:0,entry}]);
  }
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
  const contexts=await Promise.all([browser.createBrowserContext(),browser.createBrowserContext()]);
  const pages=[];
  for(let i=0;i<2;i++) {
    const context=contexts[i],user=[alice,bob][i];await context.setCookie({name:'little_log',value:db.createSession(user.id),url:origin+'/tracker/',path:'/tracker/',httpOnly:true,sameSite:'Lax'});
    const page=await context.newPage();page.on('dialog',dialog=>dialog.accept());page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:390,height:844});
    await page.goto(origin+'/tracker/#stickers',{waitUntil:'networkidle0'});await page.waitForFunction(()=>!document.querySelector('#economy-content').hidden);pages.push(page);
  }
  const [a,b]=pages;
  assert.equal(await a.$eval('#economy-total',el=>el.textContent),'3');await a.bringToFront();
  assert.equal(await a.$$eval('#sticker-gallery img',images=>images.length),1,'Only the owned sticker type appears in the gallery');
  assert.equal(await a.$eval('#economy-content',el=>el.lastElementChild.previousElementSibling.contains(document.querySelector('#sticker-gallery'))&&el.lastElementChild.contains(document.querySelector('#economy-history'))),true,'Gallery is immediately above wallet activity at the bottom');
  await a.$$eval('#sticker-gallery img',images=>images.forEach(img=>{img.loading='eager';}));
  await a.waitForFunction(()=>[...document.querySelectorAll('#sticker-gallery img')].every(img=>img.complete&&img.naturalWidth>0));
  for(const width of [320,390,680,1024,1440]) {
    await a.setViewport({width,height:900});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Gallery overflow at '+width);
  }
  await a.setViewport({width:390,height:844});await a.bringToFront();
  assert.equal(await a.$eval('#economy-form',form=>form.closest('dialog')?.id),'market-dialog');
  await a.click('#sticker-gallery button');await a.waitForFunction(()=>document.querySelector('#market-dialog').open);
  assert.equal(await a.$eval('#market-sticker',select=>select.value),type.id);
  assert.equal(db.economy.snapshot(alice.id).wallet.coins,15,'Opening the dialog does not submit a sale');
  for(const width of [320,390,680,1024,1440]) {
    await a.setViewport({width,height:844});assert.equal(await a.$eval('#market-dialog',dialog=>dialog.scrollWidth<=dialog.clientWidth),true,'Sale modal fits '+width);
  }
  await a.setViewport({width:390,height:844});await a.screenshot({path:resolve(directory,'sale-modal-mobile.png')});
  await a.keyboard.press('Escape');await a.waitForFunction(()=>!document.querySelector('#market-dialog').open);
  assert.equal(db.economy.snapshot(alice.id).wallet.coins,15,'Escape cancels without a transaction');
  assert.equal(await a.$('#market-bank-open'),null,'Bank browsing is removed');
  assert.equal(await a.$('#market-action option[value="bank-buy"]'),null,'Bank purchases are removed from the sale dialog');
  await a.$eval('#sticker-gallery button',button=>button.scrollIntoView({block:'center'})); // Keep the target above the fixed mobile navigation after closing the dialog.
  await a.click('#sticker-gallery button');
  await a.click('#market-submit');await a.waitForFunction(()=>document.querySelector('#economy-coins').textContent==='25');
  await a.waitForFunction(()=>!document.querySelector('#market-dialog').open);await a.click('#sticker-gallery button');
  await a.select('#market-action','list-coins');await a.$eval('#market-price',el=>{el.value='7';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await a.click('#market-submit');await a.waitForFunction(()=>document.querySelector('#market-listings').textContent.includes('Your listing:'));
  await b.bringToFront();await b.click('#economy-refresh');await b.waitForFunction(()=>document.querySelector('#market-listings').textContent.includes('Buy bundle'));
  await b.click('#sticker-gallery button');assert.equal(await b.$eval('#market-sticker',select=>select.value),type.id);await b.click('#market-submit');await b.waitForFunction(()=>document.querySelector('#economy-coins').textContent==='26');
  await b.click('#market-listings button');await b.waitForFunction(()=>document.querySelector('#economy-coins').textContent==='19');
  assert.equal(db.economy.snapshot(alice.id).wallet.coins,32);assert.equal(db.economy.snapshot(bob.id).types.find(t=>t.id===type.id).quantity,3);
  // Drop a successful response after the server commits, then retry through the actual UI.
  await b.setRequestInterception(true);let dropped=false;
  b.on('request',async request=>{
    if(!dropped&&request.url().endsWith('/api/economy')&&request.method()==='POST') {
      dropped=true;const response=await fetch(request.url(),{method:'POST',headers:request.headers(),body:request.postData()});assert.equal(response.status,200);await request.abort('failed');
    }else await request.continue();
  });
  await b.click('#sticker-gallery button');await b.click('#market-submit');await b.waitForFunction(()=>!document.querySelector('#market-retry').hidden);
  assert.equal(await b.$eval('#market-dialog',dialog=>dialog.open),true,'An uncertain sale keeps its retry visible in the modal');
  const balance=db.economy.snapshot(bob.id).wallet.coins;
  await b.reload({waitUntil:'networkidle0'});await b.waitForFunction(()=>!document.querySelector('#economy-retry').hidden);await b.click('#economy-retry');
  await b.waitForFunction(()=>document.querySelector('#economy-retry').hidden);assert.equal(db.economy.snapshot(bob.id).wallet.coins,balance);
  await b.screenshot({path:resolve(directory,'market-mobile.png'),fullPage:true});
  await b.evaluate(()=>{location.hash='#settings';});await b.waitForFunction(()=>!document.querySelector('#page-settings').hidden);
  await b.click('#disconnect-account');await b.waitForFunction(()=>document.querySelector('#economy-content').hidden);
  await b.evaluate(()=>{location.hash='#stickers';});await b.waitForFunction(()=>!document.querySelector('#economy-sign-in').hidden);
  assert.deepEqual(errors,[]);console.log('Economy browser passed: images, five widths, bank sales, peer purchase, lost-response retry across reload, account isolation and sign-out. Screenshot: '+directory);
}finally {
  await browser?.close();db?.close();if(server)await new Promise(done=>server.close(done));
}
