import {navigateMenu} from './navigation-helper.mjs';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(process.env.PUPPETEER_MODULE).href)).default;
await mkdir('artifacts',{recursive:true});const directory=await mkdtemp(resolve('artifacts/themes-'));
Object.assign(process.env,{NODE_ENV:'test',HOST:'127.0.0.1',PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:4173',OIDC_ISSUER:'http://127.0.0.1:4174',BASE_PATH:'/tracker/',DATA_DIR:directory});
const {server}=await import('../scripts/serve.mjs');if(!server.listening)await new Promise(done=>server.once('listening',done));
const origin='http://127.0.0.1:'+server.address().port+'/tracker/';let browser;const errors=[];
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,pipe:true});
  const context=await browser.createBrowserContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width:1440,height:1100});await page.goto(origin,{waitUntil:'networkidle0'});
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'little-tracker');
  assert.deepEqual(await page.$$eval('#navigation-content [data-page]',nodes=>nodes.map(n=>n.dataset.page)),['overview','potty-chart','stickers','games','social','login-bonuses','history','settings','about']);
  assert.equal(await page.$eval('#menu-toggle',el=>getComputedStyle(el).display),'none');
  assert.equal(await page.$eval('#desktop-navigation',el=>el.contains(document.querySelector('[data-page="overview"]'))),true);
  await page.setViewport({width:390,height:844});
  assert.equal(await page.$eval('#main-navigation',el=>el.open),false);
  await page.click('#menu-toggle');await page.$eval('#main-navigation',el=>Promise.all(el.getAnimations().map(a=>a.finished)));
  assert.equal(await page.$eval('#menu-toggle',el=>el.getAttribute('aria-expanded')),'true');
  for(let i=0;i<14;i++){await page.keyboard.press('Tab');assert.equal(await page.$eval('#main-navigation',el=>el.contains(document.activeElement)),true);}
  await page.keyboard.press('Escape');assert.equal(await page.$eval('#menu-toggle',el=>el.getAttribute('aria-expanded')),'false');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'menu-toggle');
  await page.click('#menu-toggle');await page.$eval('#main-navigation',el=>Promise.all(el.getAnimations().map(a=>a.finished)));await page.mouse.click(380,100);
  assert.equal(await page.$eval('#main-navigation',el=>el.open),false);

  await page.click('#menu-toggle');
  await page.setViewport({width:1440,height:1100});
  await page.waitForFunction(()=>!document.querySelector('#main-navigation').open);
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('navigation-open')),false,'Resizing an open drawer releases the page');
  assert.equal(await page.$eval('#desktop-navigation',el=>el.contains(document.activeElement)),true,'Focus returns to the desktop links');
  assert.equal(await page.$eval('#crt-toggle',el=>el.getAttribute('aria-pressed')),'false');
  await page.screenshot({path:resolve(directory,'little-tracker-desktop.png'),fullPage:true});
  await page.$eval('#liquids',el=>{el.value='321';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await navigateMenu(page,'[data-page="settings"]');await page.select('#theme-selector','caregiver-tracker');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),'rgb(26, 6, 17)');
  assert.equal(await page.$eval('#crt-toggle',el=>el.getAttribute('aria-pressed')),'true');
  assert.equal(await page.$eval('#liquids',el=>el.value),'321','Switching themes retains unfinished forms');
  await page.reload({waitUntil:'networkidle0'});assert.equal(await page.$eval('#theme-selector',el=>el.value),'caregiver-tracker');
  await navigateMenu(page,'[data-page="overview"]');await page.screenshot({path:resolve(directory,'caregiver-tracker-desktop.png'),fullPage:true});
  for(const theme of ['little-tracker','caregiver-tracker']) {
    await navigateMenu(page,'[data-page="settings"]');await page.select('#theme-selector',theme);
    for(const width of [320,390,680,681,1024,1440]) {
      await page.setViewport({width,height:900});
      await page.waitForFunction(mobile=>document.querySelector('#navigation-content').parentElement.id===(mobile?'main-navigation':'desktop-navigation'),{},width<=680);
      if(width<=680) {
      await navigateMenu(page,'[data-page="settings"]'); // Use a scrollable page before testing the floating menu at each width.
      await page.evaluate(()=>scrollTo(0,0));
      const menuTop=await page.$eval('#menu-toggle',el=>el.getBoundingClientRect().top);
      await page.evaluate(()=>{scrollTo(0,600);return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      assert.ok(await page.evaluate(()=>scrollY>200),'Page scrolled before testing the menu');
      assert.equal(await page.$eval('#menu-toggle',el=>getComputedStyle(el).position),'fixed');
      assert.equal(await page.$eval('#menu-toggle',el=>el.getBoundingClientRect().top),menuTop,'Menu stays at the same viewport position');
      if(width===390)await page.screenshot({path:resolve(directory,theme+'-menu-scrolled.png')});
      await page.click('#menu-toggle');await page.$eval('#main-navigation',el=>Promise.all(el.getAnimations().map(a=>a.finished)));
      assert.equal(await page.$eval('#main-navigation',el=>el.scrollWidth<=el.clientWidth),true,'Drawer overflow '+theme+' '+width);
      const links=await page.$$eval('#main-navigation [data-page]',els=>els.map(el=>({top:el.getBoundingClientRect().top,left:el.getBoundingClientRect().left})));
      assert.equal(new Set(links.map(link=>link.left)).size,1);assert.ok(links.every((link,i)=>!i||link.top>links[i-1].top));
      if(width===390)await page.screenshot({path:resolve(directory,theme+'-drawer-mobile.png')});
      await page.click('#menu-close');
      } else {
        assert.equal(await page.$eval('#menu-toggle',el=>getComputedStyle(el).display),'none');
        assert.equal(await page.$$eval('#desktop-navigation [data-page]',els=>els.filter(el=>el.getClientRects().length).length),9,'Desktop destinations remain visible');
        assert.equal(await page.$eval('#desktop-navigation',el=>el.getBoundingClientRect().right<=document.querySelector('main').getBoundingClientRect().left),true,'Sidebar sits beside the content');
      }

      for(const route of ['settings','overview','history','potty-chart','stickers','games','login-bonuses','social','post','friends','feed','messages','activity','about']) {
        await page.evaluate(route=>{location.hash='#'+route;},route);await page.waitForFunction(route=>!document.querySelector('#page-'+route).hidden,{},route);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,theme+' '+route+' overflows '+width);
        assert.equal(await page.$eval('#status-form',n=>n.getClientRects().length>0),route==='post','The composer is only visible in Post');
        const social=['social','post','friends','feed','messages','activity'].includes(route);
        assert.equal(await page.$eval('#page-social',n=>!n.hidden),social);
        if(social){
          assert.equal(await page.$eval('[data-page="social"]',n=>n.getAttribute('aria-current')),'page');
          assert.deepEqual(await page.$$eval('#social-navigation a',nodes=>nodes.map(n=>n.textContent.trim())),['Post','Feed','Friends & search','Messaging','Notifications']);
          assert.equal(await page.$eval('#social-navigation',n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&Math.abs(r.bottom-innerHeight)<2;}),true,'Social bar fits the viewport');
          assert.equal(await page.$eval('.mobile-actions',n=>getComputedStyle(n).display),'none');
        }

      }
    }
  }
  await page.setViewport({width:390,height:844});await navigateMenu(page,'[data-page="settings"]');await page.select('#theme-selector','little-tracker');
  await page.screenshot({path:resolve(directory,'little-tracker-settings-mobile.png'),fullPage:true});
  await navigateMenu(page,'[data-page="overview"]');await page.screenshot({path:resolve(directory,'little-tracker-mobile.png'),fullPage:true});
  await navigateMenu(page,'[data-page="potty-chart"]');await page.screenshot({path:resolve(directory,'little-tracker-chart.png'),fullPage:true});
  const second=await context.newPage();await second.goto(origin+'#settings',{waitUntil:'networkidle0'});
  await second.select('#theme-selector','caregiver-tracker');await page.waitForFunction(()=>document.documentElement.dataset.theme==='caregiver-tracker',{polling:100});
  await second.close();await page.bringToFront();await navigateMenu(page,'[data-page="settings"]');
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.setOfflineMode(true);await page.select('#theme-selector','little-tracker');await page.reload({waitUntil:'networkidle0'});
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'little-tracker');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),'rgb(255, 245, 250)');
  await page.select('#theme-selector','caregiver-tracker');assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor),'rgb(26, 6, 17)');
  await navigateMenu(page,'[data-page="overview"]');assert.equal(await page.$eval('#page-overview',el=>el.hidden),false);
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.click('#menu-toggle');assert.equal(await page.$eval('#main-navigation',el=>el.getAnimations().length),0);await page.keyboard.press('Escape');
  const isolated=await browser.createBrowserContext(),blocked=await isolated.newPage();blocked.on('pageerror',error=>errors.push(error.message));
  await blocked.evaluateOnNewDocument(()=>{const save=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='little-log.theme')throw new Error('Storage blocked');return save.call(this,key,value);};});
  await blocked.goto(origin+'#settings',{waitUntil:'networkidle0'});await blocked.select('#theme-selector','caregiver-tracker');
  assert.equal(await blocked.evaluate(()=>document.documentElement.dataset.theme),'caregiver-tracker');assert.match(await blocked.$eval('#theme-status',el=>el.textContent),/could not save/);
  assert.deepEqual(errors,[]);console.log('Theme browser passed: default, both designs, persistent selection, draft preservation, six widths, responsive navigation and routes, cross-tab updates, offline reload and blocked storage. Screenshots: '+directory);
}finally{await browser?.close();await new Promise(done=>server.close(done));}
