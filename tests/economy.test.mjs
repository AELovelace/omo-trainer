import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const collection=[{id:'rose',name:'Rose',url:'stickers/rose.png'},{id:'moon',name:'Moon',url:'stickers/moon.png'}];
const observation=id=>({id,kind:'observation',occurredAt:'2026-09-12T12:00:00+00:00',liquidsMl:100,liquidsMode:'interval',diaperNumber:1});
const chart=(stars={})=>({name:'Test',since:'2026-09-12',refusals:0,escaped:false,rows:[{id:'potty',label:'Potty',note:''},{id:'custom',label:'Water',note:'Recorded intake'}],stars});
function fixture(path=':memory:',catalog=[collection[0]]) { // Tests use disposable accounts and deterministic single-sticker collections.
  const db=openDatabase(path,{stickerCatalog:catalog});
  const a=db.ensureParticipant('issuer','alice','Alice'),b=db.ensureParticipant('issuer','bob','Bob');
  return {db,a,b};
}
function save(db,user,entry,baseVersion=0) {return db.sync(user.id,[{id:entry.id,mutationId:randomUUID(),baseVersion,entry}]);}
const action=(db,user,input)=>db.economy.act(user.id,{requestId:randomUUID(),...input});
function sell(db,user,sticker='rose',quantity=1) {return action(db,user,{action:'bank-sell',sticker,quantity,expectedPrice:db.economy.snapshot(user.id).types.find(t=>t.id===sticker).price});}

test('observations, wettings and changes each earn one random sticker; edits, retries, conflicts, rolls and tombstones do not duplicate rewards',()=>{
  const {db,a,b}=fixture(':memory:',collection);
  try {
    const records=[observation('obs'),{id:'wet',kind:'wetting',occurredAt:observation('x').occurredAt,category:'voluntary',position:'sitting',diaperNumber:1},{id:'change',kind:'diaper-change',occurredAt:observation('x').occurredAt,diaperNumber:1,wettingsCount:1}];
    const changes=records.map(entry=>({id:entry.id,mutationId:entry.id,baseVersion:0,entry}));
    db.sync(a.id,changes);db.sync(a.id,changes);
    save(db,a,{...records[0],liquidsMl:200},1);assert.equal(save(db,a,records[0],0).conflicts.length,1);
    db.sync(a.id,[{id:'obs',mutationId:'delete',baseVersion:2,entry:null}]);save(db,a,records[0],3);
    const roll={id:'roll',kind:'roll',occurredAt:observation('x').occurredAt,rolledAt:observation('x').occurredAt,result:'hold',rolledResult:'hold',probability:50,source:'random'};save(db,a,roll);
    const snap=db.economy.snapshot(a.id);assert.equal(snap.types.reduce((n,t)=>n+t.quantity,0),3);assert.equal(snap.history.length,3);
    assert.ok(snap.history.every(row=>collection.some(type=>type.id===row.asset)));
    assert.equal(db.economy.snapshot(b.id).types.reduce((n,t)=>n+t.quantity,0),0);
  }finally{db.close();}
});

test('star currency credits each date/row once, survives clearing and leaves chart progress unchanged',()=>{
  const {db,a}=fixture();
  try {
    const original=chart({'2026-09-12:custom':true});
    const write=(value,version)=>db.saveGrowthChart(a.id,{chart:value,baseVersion:version,mutationId:randomUUID()});
    write(original,0);write(chart(),1);write(original,2);
    assert.equal(db.economy.snapshot(a.id).wallet.stars,1);assert.equal(db.growthChart(a.id).chart.stars['2026-09-12:custom'],true);
    assert.throws(()=>write(chart({'2026-09-13:custom':true}),1),error=>error.status===409);
    assert.equal(db.economy.snapshot(a.id).wallet.stars,1);
  }finally{db.close();}
});

test('bank conversion tracks stock, issuance, whole-number balances and demand from distinct traders',()=>{
  const {db,a,b}=fixture();
  try {
    save(db,a,observation('a'));save(db,a,observation('a2'));save(db,b,observation('b'));save(db,b,observation('b2'));
    const command={action:'bank-sell',sticker:'rose',quantity:1,expectedPrice:10,requestId:'retry-sale'};
    const receipt=db.economy.act(a.id,command);assert.deepEqual(db.economy.act(a.id,command),receipt);
    assert.throws(()=>db.economy.act(a.id,{...command,quantity:2}),error=>error.status===409);
    assert.equal(db.economy.snapshot(a.id).wallet.coins,10);sell(db,a);
    let state=db.economy.snapshot(a.id);assert.equal(state.types[0].price,11);assert.equal(state.types[0].traders,1);assert.equal(state.bank.issuedCoins,21);assert.equal(state.types[0].bankQuantity,2);
    sell(db,b);state=db.economy.snapshot(b.id);assert.equal(state.types[0].price,12);assert.equal(state.types[0].traders,2);
    assert.throws(()=>action(db,b,{action:'bank-buy',sticker:'rose',quantity:1,expectedPrice:11}),error=>error.status===409);
    action(db,a,{action:'bank-buy',sticker:'rose',quantity:1,expectedPrice:12});state=db.economy.snapshot(a.id);
    assert.equal(state.wallet.coins,9);assert.equal(state.types[0].quantity,1);assert.equal(state.types[0].bankQuantity,2);assert.equal(state.bank.coins,12);
    for(const quantity of [0,-1,1.2,'1',Infinity,10001])assert.throws(()=>action(db,a,{action:'bank-sell',sticker:'rose',quantity,expectedPrice:12}),error=>error.status===400);
    assert.equal(db.economy.snapshot(a.id).wallet.coins,9);
  }finally{db.close();}
});

test('market reserves stickers, atomically exchanges coins, rejects self trades and double spending, and returns cancelled escrow',()=>{
  const {db,a,b}=fixture();
  try {
    save(db,a,observation('a'));save(db,b,observation('b'));sell(db,b);
    const listing=action(db,a,{action:'list',sticker:'rose',quantity:1,wantQuantity:7});
    assert.equal(db.economy.snapshot(a.id).types[0].quantity,0);assert.equal(db.economy.snapshot(a.id).types[0].escrow,1);
    assert.throws(()=>sell(db,a),error=>error.status===409);
    assert.throws(()=>action(db,a,{action:'accept',listingId:listing.listingId}),error=>error.status===400);
    assert.throws(()=>action(db,b,{action:'cancel',listingId:listing.listingId}),error=>error.status===403);
    const request={requestId:'accept-once',action:'accept',listingId:listing.listingId};db.economy.act(b.id,request);db.economy.act(b.id,request);
    assert.throws(()=>action(db,b,{...request,requestId:'second-buyer'}),error=>error.status===409);
    assert.equal(db.economy.snapshot(a.id).wallet.coins,7);assert.equal(db.economy.snapshot(b.id).wallet.coins,3);
    assert.equal(db.economy.snapshot(b.id).types[0].quantity,1);
    const other=action(db,b,{action:'list',sticker:'rose',quantity:1,wantQuantity:8});
    assert.throws(()=>action(db,a,{action:'accept',listingId:other.listingId}),error=>error.status===409);
    assert.equal(db.economy.snapshot(a.id).wallet.coins,7,'A failed purchase rolls back every transfer leg');
    action(db,b,{action:'cancel',listingId:other.listingId});assert.equal(db.economy.snapshot(b.id).types[0].quantity,1);
    assert.equal(db.economy.snapshot(b.id).listings.length,0);
  }finally{db.close();}
});


test('pending rewards, exact sticker identities, swaps and receipts survive reopening; inactive assets never erase inventory',()=>{
  const directory=mkdtempSync(join(tmpdir(),'little-log-economy-')),path=join(directory,'test.sqlite');
  let {db,a,b}=fixture(path,[]);
  try {
    save(db,a,observation('a'));assert.equal(db.economy.snapshot(a.id).pendingRewards,1);db.close();
    db=openDatabase(path,{stickerCatalog:[collection[0]]});assert.equal(db.economy.snapshot(a.id).types[0].quantity,1);db.close();
    db=openDatabase(path,{stickerCatalog:[collection[1]]});save(db,b,observation('b'));
    const offer=action(db,a,{action:'list',sticker:'rose',quantity:1,wantSticker:'moon',wantQuantity:1});
    const input={requestId:'swap-retry',action:'accept',listingId:offer.listingId};db.economy.act(b.id,input);db.close();
    db=openDatabase(path,{stickerCatalog:collection});db.economy.act(b.id,input);
    const alice=db.economy.snapshot(a.id),bob=db.economy.snapshot(b.id);
    assert.equal(alice.types.find(t=>t.id==='moon').quantity,1);assert.equal(bob.types.find(t=>t.id==='rose').quantity,1);
    assert.equal(alice.wallet.coins,0);assert.equal(bob.wallet.coins,0);assert.ok(alice.types.every(t=>t.traders===2));
    const raw=new DatabaseSync(join(directory,'market.sqlite'));
    for(const user of [a,b])for(const type of collection) {
      const deltas=raw.prepare('SELECT COALESCE(SUM(delta),0) AS n FROM economy_ledger WHERE owner=? AND asset=?').get(user.id,type.id).n;
      assert.equal(deltas,db.economy.snapshot(user.id).types.find(t=>t.id===type.id).quantity);
    }
    raw.close();
  }finally{db.close();rmSync(directory,{recursive:true});}
});

test('record and reward mutations roll back together on a failed batch',()=>{
  const {db,a}=fixture();
  try {
    const first={id:'first',mutationId:'receipt',baseVersion:0,entry:observation('first')};db.sync(a.id,[first]);
    assert.throws(()=>db.sync(a.id,[{id:'second',mutationId:'new',baseVersion:0,entry:observation('second')},{...first,entry:{...first.entry,liquidsMl:300}}]),error=>error.status===400);
    assert.equal(db.records(a.id).length,1);assert.equal(db.economy.snapshot(a.id).types[0].quantity,1);
  }finally{db.close();}
});

test('existing imported IDs earn once and imports cannot overwrite wallet balances',()=>{
  const {db,a,b}=fixture();
  try {
    db.admin.bootstrap(a.id);
    const input={format:'json',mode:'merge',participantId:b.id,text:JSON.stringify({version:1,entries:[observation('imported')],wallet:{coins:999999}})};
    const preview=db.admin.previewImport(a.id,input);db.admin.importData(a.id,{...input,token:preview.token});
    assert.equal(db.economy.snapshot(b.id).types[0].quantity,1);assert.equal(db.economy.snapshot(b.id).wallet.coins,0);
    db.admin.importData(a.id,{...input,token:db.admin.previewImport(a.id,input).token});assert.equal(db.economy.snapshot(b.id).types[0].quantity,1);
    db.ensureParticipant('issuer','bob','New name');assert.equal(db.economy.snapshot(b.id).types[0].quantity,1);
  }finally{db.close();}
});

test('economy API uses session ownership, CSRF, no-store and disabled-account access checks',async()=>{
  const {db,a,b}=fixture();db.admin.bootstrap(a.id);save(db,a,observation('a'));save(db,b,observation('b'));
  const token=db.createSession(a.id),other=db.createSession(b.id),login={origin:'',session:req=>db.session(req.headers.cookie)};
  const api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));login.origin='http://127.0.0.1:'+server.address().port;
  const get=(cookie,route='economy')=>fetch(login.origin+'/'+route,{headers:cookie?{Cookie:cookie}:{}});
  try {
    assert.equal((await get()).status,401);const response=await get(token,'economy?participantId='+b.id);
    assert.equal(response.headers.get('cache-control'),'no-store');const data=await response.json();assert.equal(data.participant.id,a.id);
    assert.ok(!JSON.stringify(data).includes(b.id));
    const headers={Cookie:token,'Content-Type':'application/json',Origin:login.origin},input={requestId:'bank',action:'bank-sell',sticker:'rose',quantity:1,expectedPrice:10,participantId:b.id};
    const post=extra=>fetch(login.origin+'/economy',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(input)});
    assert.equal((await post({})).status,403);assert.equal((await post({'X-CSRF-Token':data.csrf,Origin:'https://wrong.example'})).status,403);
    assert.equal((await post({'X-CSRF-Token':data.csrf})).status,200);assert.equal(db.economy.snapshot(a.id).wallet.coins,10);assert.equal(db.economy.snapshot(b.id).wallet.coins,0);
    const offer=action(db,b,{action:'list',sticker:'rose',quantity:1,wantQuantity:5});
    db.admin.updateUser(a.id,{id:b.id,action:'update',role:'participant',disabled:true,version:0});
    assert.equal((await get(other)).status,401);assert.equal(db.economy.snapshot(a.id).listings.length,0);
    assert.throws(()=>action(db,a,{action:'accept',listingId:offer.listingId}),error=>error.status===409);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});


test('scientific saves succeed while market is locked; durable outbox recovery and crash replay never duplicate rewards',()=>{
  const directory=mkdtempSync(join(tmpdir(),'little-log-separated-')),path=join(directory,'science.sqlite');
  let {db,a}=fixture(path);db.economy.snapshot(a.id);
  const market=new DatabaseSync(join(directory,'market.sqlite')),science=new DatabaseSync(path);
  try {
    assert.equal(science.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'sticker_%' OR name LIKE 'economy_%'").get().n,0);
    assert.equal(market.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('entries','growth_charts','participants','app_sessions')").get().n,0);
    market.exec('BEGIN IMMEDIATE');
    save(db,a,observation('outage'));db.saveGrowthChart(a.id,{chart:chart({'2026-09-12:custom':true}),baseVersion:0,mutationId:'outage-chart'});
    assert.equal(db.records(a.id).length,1);assert.equal(science.prepare('SELECT COUNT(*) AS n FROM reward_outbox WHERE delivered=0').get().n,2);
    market.exec('ROLLBACK');db.close();db=openDatabase(path,{stickerCatalog:[collection[0]]});
    const recovered=db.economy.snapshot(a.id);assert.equal(recovered.types[0].quantity,1);assert.equal(recovered.wallet.stars,1);
    science.exec('UPDATE reward_outbox SET delivered=0'); // Simulate a crash after market commit and before outbox acknowledgement.
    db.economy.tryFlush();assert.equal(db.economy.snapshot(a.id).types[0].quantity,1);assert.equal(db.economy.snapshot(a.id).wallet.stars,1);
    assert.equal(market.prepare("SELECT COUNT(*) AS n FROM sticker_rewards WHERE kind<>'record'").get().n,0);
    assert.equal(market.prepare("SELECT COUNT(*) AS n FROM star_rewards WHERE cell LIKE '%custom%'").get().n,0);
  }finally{market.close();science.close();db.close();rmSync(directory,{recursive:true});}
});

test('distinct demand expires after 30 days and cannot be increased by repeated trades from one person',()=>{
  const directory=mkdtempSync(join(tmpdir(),'little-log-pricing-')),path=join(directory,'science.sqlite');const {db,a}=fixture(path);
  try {
    for(const id of ['one','two','three'])save(db,a,observation(id));sell(db,a);sell(db,a);sell(db,a);
    assert.equal(db.economy.snapshot(a.id).types[0].price,11);
    const market=new DatabaseSync(join(directory,'market.sqlite'));market.prepare('UPDATE sticker_trades SET created_at=?').run(new Date(Date.now()-31*86400000).toISOString());market.close();
    assert.equal(db.economy.snapshot(a.id).types[0].price,10);
  }finally{db.close();rmSync(directory,{recursive:true});}
});


test('duplicate designs merge user and bank inventory, rewards and escrow while retaining receipts and market history',async()=>{
  const {createEconomy}=await import('../server/economy.mjs');
  const {stickerCatalog}=await import('../server/sticker-catalog.mjs');
  const {STICKER_DUPLICATES}=await import('../server/sticker-duplicates.mjs');
  const market=new DatabaseSync(':memory:');market.exec('PRAGMA foreign_keys=ON');
  const first=stickerCatalog()[0],second=stickerCatalog()[1],duplicate={id:STICKER_DUPLICATES[0].alias,name:'Sticker 13',url:'sprites/13.png'};
  let economy=createEconomy(market,[duplicate],()=>true,[]);
  const perform=(owner,input)=>economy.act(owner,{requestId:randomUUID(),...input});
  try {
    for(let i=0;i<6;i++)economy.awardRecord('alice',{id:'duplicate-'+i});economy.awardRecord('bob',{id:'duplicate-bob'});
    const oldSale={requestId:'old-sale',action:'bank-sell',sticker:duplicate.id,quantity:1,expectedPrice:10};const saleReceipt=economy.act('alice',oldSale);
    economy=createEconomy(market,[first],()=>true,[]);economy.awardRecord('alice',{id:'original'});economy.awardRecord('bob',{id:'original'});
    perform('bob',{action:'bank-sell',sticker:first.id,quantity:1,expectedPrice:10});
    economy=createEconomy(market,[second],()=>true,[]);economy.awardRecord('bob',{id:'second-design'});
    const coins=perform('alice',{action:'list',sticker:duplicate.id,quantity:1,wantQuantity:5});
    const selfSwap=perform('alice',{action:'list',sticker:duplicate.id,quantity:1,wantSticker:first.id,wantQuantity:1});
    const wanted=perform('bob',{action:'list',sticker:second.id,quantity:1,wantSticker:duplicate.id,wantQuantity:1});
    economy=createEconomy(market,stickerCatalog());
    const alice=economy.snapshot('alice'),bob=economy.snapshot('bob'),merged=alice.types.find(type=>type.id===first.id);
    assert.equal(alice.types.length,12);assert.ok(!alice.types.some(type=>type.id===duplicate.id));
    assert.equal(merged.quantity,5);assert.equal(merged.escrow,1);assert.equal(merged.earned,7);assert.equal(merged.bankQuantity,2);
    assert.equal(merged.traders,2);assert.equal(merged.price,12);assert.equal(bob.types.find(type=>type.id===first.id).quantity,1);
    assert.equal(alice.wallet.coins,10);assert.equal(bob.wallet.coins,10);assert.equal(alice.bank.issuedCoins,20);
    assert.equal(alice.listings.find(offer=>offer.id===coins.listingId).sticker,first.id);
    assert.equal(alice.listings.find(offer=>offer.id===wanted.listingId).wantSticker,first.id);
    assert.ok(!alice.listings.some(offer=>offer.id===selfSwap.listingId));assert.ok(alice.history.some(event=>event.reason==='duplicate swap cancelled'));
    assert.equal(market.prepare('SELECT COUNT(*) AS n FROM sticker_trades WHERE sticker=?').get(duplicate.id).n,1,'Historical trades retain their original asset ID');
    assert.deepEqual(economy.act('alice',oldSale),saleReceipt,'A pre-migration retry never repeats its payment');
    const historyLength=alice.history.length;economy=createEconomy(market,stickerCatalog());assert.equal(economy.snapshot('alice').history.length,historyLength);
    perform('alice',{action:'bank-sell',sticker:duplicate.id,quantity:1,expectedPrice:12});
    assert.equal(economy.snapshot('alice').types.find(type=>type.id===first.id).quantity,4);assert.equal(economy.snapshot('alice').wallet.coins,22);
    assert.equal(market.prepare('SELECT COALESCE(SUM(quantity),0) AS n FROM sticker_inventory WHERE sticker=?').get(duplicate.id).n,0);
    assert.equal(market.prepare('SELECT COALESCE(SUM(delta),0) AS n FROM economy_ledger WHERE owner=? AND asset=?').get('alice',first.id).n,4);
  }finally{market.close();}
});

test('a duplicate merge that would overflow a balance rolls back without losing either holding',async()=>{
  const {createEconomy}=await import('../server/economy.mjs');const {stickerCatalog}=await import('../server/sticker-catalog.mjs');const {STICKER_DUPLICATES}=await import('../server/sticker-duplicates.mjs');
  const market=new DatabaseSync(':memory:'),original=stickerCatalog()[0],duplicate={id:STICKER_DUPLICATES[0].alias,name:'Sticker 13',url:'sprites/13.png'};
  try {
    let economy=createEconomy(market,[duplicate],()=>true,[]);economy.awardRecord('alice',{id:'one'});
    economy=createEconomy(market,[original],()=>true,[]);economy.awardRecord('alice',{id:'two'});
    market.prepare('UPDATE sticker_inventory SET quantity=2147483647 WHERE sticker=?').run(original.id);
    assert.throws(()=>createEconomy(market,stickerCatalog()),error=>error.status===409);
    assert.equal(market.prepare('SELECT quantity FROM sticker_inventory WHERE sticker=?').get(duplicate.id).quantity,1);
    assert.equal(market.prepare('SELECT quantity FROM sticker_inventory WHERE sticker=?').get(original.id).quantity,2147483647);
    assert.equal(market.prepare('SELECT COUNT(*) AS n FROM sticker_aliases').get().n,0);
  }finally{market.close();}
});
