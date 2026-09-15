import {navigateMenu} from './navigation-helper.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/games-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory,LIDOLLBOT_PUBLIC_ORIGIN:'https://bot.example'});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(done=>server.once('listening',done));
const origin='http://127.0.0.1:'+server.address().port+'/tracker/';let browser;const errors=[];
try{
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width:1440,height:1100});await page.goto(origin,{waitUntil:'networkidle0'});
  await page.$eval('#liquids',el=>{el.value='321';el.dispatchEvent(new Event('input',{bubbles:true}));});
  for(const theme of ['little-tracker','caregiver-tracker']){
    await navigateMenu(page,'[data-page="settings"]');await page.select('#theme-selector',theme);await navigateMenu(page,'[data-page="games"]');
    assert.equal(await page.$eval('#page-games',el=>el.hidden),false);assert.equal(await page.$$eval('[data-game-link]',els=>els.length),4);
    assert.equal(await page.$eval('#liquids',el=>el.value),'321');
    for(const width of [320,390,680,1024,1440]){await page.setViewport({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${theme} overflow at ${width}`);}
    await page.screenshot({path:resolve(directory,`${theme}-desktop.png`),fullPage:true});
    await page.setViewport({width:390,height:844});await navigateMenu(page,'[data-page="overview"]');await navigateMenu(page,'[data-page="games"]');
    await page.screenshot({path:resolve(directory,`${theme}-mobile.png`),fullPage:true});
  }
  const response=await fetch(origin+'games/balldrop?returnTo=https://evil.example',{redirect:'manual'});assert.equal(response.headers.get('location'),'https://bot.example/balldrop/login');
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.evaluateOnNewDocument(()=>{window.fixtureOnline=false;Object.defineProperty(navigator,'onLine',{get:()=>window.fixtureOnline});});
  await page.setOfflineMode(true);await page.reload({waitUntil:'networkidle0'}); // Chrome's network emulation resets navigator.onLine on reload; provide that signal separately while requests remain offline.
  assert.match(await page.$eval('#games-connection',el=>el.textContent),/offline/);assert.equal(await page.$$eval('[data-game-link]',els=>els.every(el=>el.getAttribute('aria-disabled')==='true')),true);
  assert.equal(await page.evaluate(async()=>{const keys=await caches.keys();for(const key of keys){const cache=await caches.open(key);for(const request of await cache.keys())if(new URL(request.url).pathname.includes('/games/'))return true;}return false;}),false);
  await page.setOfflineMode(false);await page.evaluate(()=>{window.fixtureOnline=true;dispatchEvent(new Event('online'));});await page.waitForFunction(()=>document.querySelector('[data-game-link]').getAttribute('aria-disabled')==='false');assert.deepEqual(errors,[]);
  console.log('PASS: Games navigation, all cards, both themes, five widths, preserved tracker drafts, fixed redirects, offline reload and reconnect. Screenshots: '+directory);
}finally{await browser?.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
