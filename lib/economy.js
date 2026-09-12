const $=selector=>document.querySelector(selector);
let data=null,csrf='',owner='',busy=false,loading=false,epoch=0,pending=null;
const visible=()=>location.hash==='#stickers';
let marketOpener=null;
function node(tag,text,className) { // Use text nodes for catalog names and API data so filenames cannot inject markup.
  const element=document.createElement(tag);if(text!==undefined) element.textContent=text;if(className)element.className=className;return element;
}
function status(text) {
  $('#economy-status').textContent=text;
  $('#market-dialog-status').textContent=text; // Keep failures and uncertain outcomes visible inside the modal.
  window.dispatchEvent(new CustomEvent('little-log-economy-status',{detail:{connected:Boolean(owner),text:owner?'Wallet saved in your account':'Sign in for your wallet'}}));
}
function pendingKey() { return 'little-log.market-pending.'+owner; } // Keep receipt IDs per account without storing credentials or cached balances.
async function request(method,input) { // A bounded request can be retried using the same durable receipt after a connection interruption.
  const response=await fetch('./api/economy',{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),headers:method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},...(input?{body:JSON.stringify(input)}:{})});
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error||'The exchange could not be completed.'),{status:response.status});return result;
}
function openMarket(sticker,action,opener) { // Open the existing exchange controls with the clicked sticker selected; opening never submits a sale.
  if(!data||!owner)return;
  marketOpener={element:opener,sticker};
  $('#market-sticker').value=sticker;$('#market-action').value=action;$('#market-quantity').value='1';$('#market-price').value='10';
  $('#market-dialog-status').textContent=pending?'An exchange needs a retry to confirm its result. Use Retry pending exchange.':'';
  renderQuote();if(!$('#market-dialog').open)$('#market-dialog').showModal();$('#market-dialog-title').focus();
}
function renderQuote() { // Show the complete transaction price before submitting; no fractional currency enters the request.
  if(!data)return;
  const action=$('#market-action').value,type=data.types.find(type=>type.id===$('#market-sticker').value),quantity=Number($('#market-quantity').value);
  $('#market-want-wrap').hidden=action!=='list-swap';$('#market-price-wrap').hidden=!action.startsWith('list-');
  $('#market-price-label').textContent=action==='list-swap'?'Total stickers wanted':'Total LiDollCoins wanted';
  $('#market-dialog-title').textContent=(action==='bank-buy'?'Buy ':action==='list-swap'?'Trade ':'Sell ')+(type?.name??'sticker');
  $('#market-submit').textContent=action==='bank-sell'?'Sell to stickerbank':action==='bank-buy'?'Buy from stickerbank':'Create listing';
  const unit=action==='list-swap'?'stickers':'LiDollCoins';
  $('#market-quote').textContent=!type?'The sticker collection is waiting for assets.':action.startsWith('list-')?'Reserve '+quantity+' '+type.name+'; ask for '+$('#market-price').value+' '+unit+' for the whole bundle.':'Bank rate: '+type.price+' LiDollCoins each. Total: '+(Number.isSafeInteger(quantity)&&quantity>0?type.price*quantity:'--')+' LiDollCoins. Available: '+type.quantity+'; bank stock: '+type.bankQuantity+'.';
  $('#market-submit').disabled=busy||loading||Boolean(pending)||!type;
}
function render() { // Rebuild only on explicit refresh or completed actions so market drafts survive navigation.
  $('#economy-content').hidden=false;$('#economy-sign-in').hidden=true;
  $('#economy-coins').textContent=data.wallet.coins.toLocaleString();$('#economy-stars').textContent=data.wallet.stars.toLocaleString();
  $('#economy-total').textContent=data.types.reduce((sum,type)=>sum+type.quantity+type.escrow,0).toLocaleString();
  $('#economy-pending').textContent=data.pendingRewards?data.pendingRewards+' earned stickers are waiting for the sticker collection to become available.':'';
  const gallery=$('#sticker-gallery');gallery.replaceChildren();
  const ownedTypes=data.types.filter(type=>type.quantity+type.escrow>0); // Listed stickers still belong to their seller until a trade completes.
  for(const type of ownedTypes) {
    const item=node('article',undefined,'sticker-item');
    if(type.active) {const img=node('img');img.src=type.url;img.alt=type.name;img.loading='lazy';img.width=160;img.height=120;item.append(img);}
    item.append(node('h3',type.name),node('p',type.quantity+' available / '+type.escrow+' listed / '+type.earned+' earned'),node('p','Bank: '+type.bankQuantity+' | Rate: '+type.price+' coins | '+type.traders+' traders (30 days)'));
    const choose=node('button','Sell this sticker','button secondary small');choose.type='button';choose.dataset.sticker=type.id;choose.disabled=type.quantity===0;choose.onclick=()=>openMarket(type.id,'bank-sell',choose);item.append(choose);gallery.append(item);
  }
  if(!ownedTypes.length)gallery.append(node('p',data.pendingRewards?'Your earned stickers will appear here when the collection is available.':'No stickers in your collection yet. Record and sync an observation, wetting or diaper change to earn one.'));
  for(const id of ['#market-sticker','#market-want']) {
    const select=$(id),previous=select.value;select.replaceChildren();
    for(const type of data.types) {const option=node('option',type.name);option.value=type.id;select.append(option);}
    if(data.types.some(type=>type.id===previous))select.value=previous;
  }
  const names=new Map(data.types.map(type=>[type.id,type.name]));
  for(const alias of data.aliases??[]) names.set(alias.id,alias.name+' (merged into '+names.get(alias.canonical)+')'); // Keep historical ledger entries readable after duplicate types are merged.
  const listings=$('#market-listings');listings.replaceChildren();
  for(const offer of data.listings) {
    const row=node('article',undefined,'market-offer'),payment=offer.wantQuantity+' '+(offer.wantSticker?names.get(offer.wantSticker):'LiDollCoins');
    row.append(node('p',(offer.mine?'Your listing: ':'')+offer.quantity+' '+names.get(offer.sticker)+' for '+payment));
    const button=node('button',offer.mine?'Cancel listing':offer.wantSticker?'Accept swap':'Buy bundle','button secondary');button.type='button';button.disabled=busy||loading||Boolean(pending);
    button.onclick=()=>execute({action:offer.mine?'cancel':'accept',listingId:offer.id});row.append(button);listings.append(row);
  }
  if(!data.listings.length)listings.append(node('p','No open listings yet. List a sticker to start the market.'));
  $('#bank-balances').textContent='Bank wallet: '+data.bank.coins.toLocaleString()+' LiDollCoins. Total coins issued: '+data.bank.issuedCoins.toLocaleString()+'.';
  const history=$('#economy-history');history.replaceChildren();
  for(const event of data.history)history.append(node('li',new Date(event.createdAt).toLocaleString()+' | '+(event.delta>0?'+':'')+event.delta+' '+(names.get(event.asset)||event.asset)+' | '+event.reason));
  for(const id of ['#economy-retry','#market-retry']) {$(id).hidden=!pending;$(id).disabled=busy;}
  $('#market-bank-open').disabled=!data.types.length;renderQuote();
}
async function refresh() { // Read the authoritative wallet on entering the gallery; never display a previous account's cached wallet.
  if(loading||busy)return;loading=true;const current=epoch;status('Loading your collection...');
  $('#market-submit').disabled=true;document.querySelectorAll('#market-listings button').forEach(button=>{button.disabled=true;});
  try {
    const result=await request('GET');if(current!==epoch)return;
    data=result;csrf=result.csrf;owner=result.participant.id;
    try {pending=JSON.parse(sessionStorage.getItem(pendingKey())||'null');}catch {pending=null;}
    render();status(pending?'An exchange needs a retry to confirm its result. Use Retry pending exchange.':'Balances are up to date.');return true;
  } catch(error) {
    if(current!==epoch)return;
    if(error.status===401||error.status===403) {data=null;csrf='';owner='';$('#market-dialog').close();$('#economy-content').hidden=true;$('#economy-sign-in').hidden=false;}
    status(error.status===401?'Sign in with LiD0llID to collect stickers and use the market.':error.message||'Connect to the internet to load your collection.');
  } finally {loading=false;if(current===epoch&&data) {renderQuote();document.querySelectorAll('#market-listings button').forEach(button=>{button.disabled=busy||Boolean(pending);});}}
}
async function execute(input,retry=false) { // Persist the exact body before sending so an uncertain result cannot cause a second purchase.
  if(busy||loading||!owner||(!retry&&pending))return;
  if(!retry) {
    pending={...input,requestId:crypto.randomUUID()};
    try {sessionStorage.setItem(pendingKey(),JSON.stringify(pending));}catch {pending=null;status('Browser storage is unavailable. Enable it before making an exchange.');return;}
  }
  const current=epoch,key=pendingKey();let completed=false;busy=true;render();status('Saving your exchange...');
  try {
    await request('POST',pending);sessionStorage.removeItem(key);
    if(current!==epoch)return;
    pending=null;completed=true;status('Exchange completed.');
  } catch(error) {
    if(current!==epoch)return;
    if(error.status>=400&&error.status<500) {sessionStorage.removeItem(key);pending=null;}
    status(pending?'The result is unconfirmed. Retry pending exchange safely when connected.':error.message);
  } finally {
    busy=false;
    if(current===epoch) {
      const message=$('#economy-status').textContent;
      if(await refresh())status(message); // Refresh changed prices and balances while retaining the outcome message.
      if(completed)$('#market-dialog').close();
    }
  }
}
$('#economy-form').addEventListener('submit',event=>{
  event.preventDefault();if(!data)return;
  const action=$('#market-action').value,sticker=$('#market-sticker').value,quantity=Number($('#market-quantity').value);
  const input={action:action.startsWith('list-')?'list':action,sticker,quantity};
  if(action.startsWith('list-')) {input.wantQuantity=Number($('#market-price').value);input.wantSticker=action==='list-swap'?$('#market-want').value:null;}
  else input.expectedPrice=data.types.find(type=>type.id===sticker)?.price;
  execute(input);
});
$('#economy-form').addEventListener('input',renderQuote);
$('#economy-refresh').addEventListener('click',refresh);
$('#economy-retry').addEventListener('click',()=>execute(pending,true));
$('#market-retry').addEventListener('click',()=>execute(pending,true));
$('#market-bank-open').addEventListener('click',event=>openMarket(data?.types.find(type=>type.bankQuantity>0)?.id??data?.types[0]?.id,'bank-buy',event.currentTarget));
$('#market-close').addEventListener('click',()=>$('#market-dialog').close());
$('#market-dialog').addEventListener('close',()=>{ // A gallery refresh can replace the original button; restore focus to its new copy when available.
  const target=marketOpener?.element?.isConnected?marketOpener.element:[...document.querySelectorAll('#sticker-gallery button')].find(button=>button.dataset.sticker===marketOpener?.sticker&&!button.disabled);
  (target??$('#economy-refresh')).focus({preventScroll:true});marketOpener=null;
});
window.addEventListener('hashchange',()=>{if(visible())refresh();else $('#market-dialog').close();});
window.addEventListener('online',()=>{if(visible())refresh();});
window.addEventListener('focus',()=>{if(visible())refresh();});
window.addEventListener('little-log-rewards-updated',()=>{if(visible())refresh();});
window.addEventListener('little-log-signout',()=>{epoch++;data=null;csrf='';owner='';pending=null;$('#market-dialog').close();$('#economy-content').hidden=true;$('#economy-sign-in').hidden=false;status('Sign in to open your collection.');});
if(visible())refresh();
