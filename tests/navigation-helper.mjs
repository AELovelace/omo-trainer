export async function navigateMenu(page,selector) { // Exercise the same drawer interaction as a participant before selecting a destination.
  const mobile=await page.evaluate(()=>matchMedia('(max-width: 680px)').matches);
  if(mobile&&!await page.$eval('#main-navigation',dialog=>dialog.open))await page.click('#menu-toggle');
  await page.$eval('#main-navigation',dialog=>Promise.all(dialog.getAnimations().map(animation=>animation.finished.catch(()=>{}))));
  const target=await page.$eval(selector,link=>link.dataset.page);
  await page.click(selector);
  await page.waitForFunction(target=>!document.querySelector('#main-navigation').open&&!document.querySelector('#page-'+target).hidden,{},target);
}
