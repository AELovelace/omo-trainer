import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createCoinApiStore,coinApps} from '../server/coin-api-store.mjs';
const all='wallet:read wallet:write stars:read stars:write';
function connect(call,user,scope=all){const d=call('begin',{client_id:'lidollquest',scope},'test');call('approve',user.id,{user_code:d.user_code,approve:true});return call('token',{client_id:'lidollquest',device_code:d.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}).access_token;}

test('stars are separate from coins and chart progress, scoped, whole, replay-safe and persisted',()=>{
 const dir=mkdtempSync(join(tmpdir(),'stars-api-')),path=join(dir,'science.sqlite');let db=openDatabase(path,{stickerCatalog:[]});
 const call=(method,...args)=>db.economy.coins(method,...args);
 try {
  const a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');
  const chart={name:'Alice',since:'2026-09-12',refusals:0,escaped:false,rows:[{id:'potty',label:'Potty',note:''},{id:'custom',label:'Custom',note:''}],stars:{'2026-09-12:custom':true}};
  db.saveGrowthChart(a.id,{chart,baseVersion:0,mutationId:'chart'});const before=db.growthChart(a.id);
  const token=connect(call,a),other=connect(call,b),legacy=connect(call,a,'wallet:read wallet:write'),read=connect(call,a,'stars:read');
  assert.equal(call('balance',token).stars,1);assert.equal(call('balance',legacy).stars,undefined);
  assert.equal(call('balance',read).balance,undefined);assert.equal(call('balance',read).stars,1);
  const earn={request_id:'star-earn',asset:'stars',kind:'credit',amount:10};
  assert.throws(()=>call('operation',legacy,earn),e=>e.code==='insufficient_scope');assert.throws(()=>call('operation',read,earn),e=>e.status===403);
  const receipt=call('operation',token,earn);assert.equal(receipt.balance,11);assert.equal(receipt.currency,'Stars');
  assert.deepEqual(call('operation',token,earn),receipt);
  assert.throws(()=>call('operation',token,{...earn,asset:'coins'}),e=>e.status===409);
  assert.throws(()=>call('operation',token,{...earn,amount:12}),e=>e.status===409);
  for(const amount of [0,-1,0.5,'1',2147483648,null])assert.throws(()=>call('operation',token,{...earn,request_id:'invalid',amount}),e=>e.status===400);
  assert.throws(()=>call('operation',token,{...earn,asset:'stickerbank'}),e=>e.status===400);
  const spend={request_id:'star-spend',asset:'stars',kind:'debit',amount:4};assert.equal(call('operation',token,spend).balance,7);
  assert.throws(()=>call('operation',token,{...spend,request_id:'overdraft',amount:8}),e=>e.status===409);
  const refund={request_id:'star-refund',asset:'stars',kind:'refund',original_id:'star-spend'};
  assert.throws(()=>call('operation',token,{...refund,asset:'coins'}),e=>e.status===409);
  assert.throws(()=>call('operation',other,refund),e=>e.status===409);
  assert.equal(call('operation',token,refund).balance,11);
  assert.equal(call('operation',token,refund).balance,11);
  assert.throws(()=>call('operation',token,{...refund,request_id:'refund-twice'}),e=>e.status===409);
  call('operation',token,{request_id:'coin-earn',kind:'credit',amount:50});
  assert.equal(call('balance',token).balance,100);assert.equal(call('balance',token).stars,11);assert.equal(call('balance',other).stars,0);
  assert.deepEqual(db.growthChart(a.id),before);assert.equal(db.records(a.id).length,0);
  db.close();db=openDatabase(path,{stickerCatalog:[]});
  assert.deepEqual(call('operation',token,earn),receipt);assert.equal(call('balance',token).stars,11);
  const market=new DatabaseSync(join(dir,'market.sqlite'));
  assert.equal(market.prepare("SELECT SUM(delta) AS n FROM economy_ledger WHERE owner=? AND asset='stars'").get(a.id).n,11);
  market.close();
  for(const link of call('connections',a.id))call('revoke',a.id,link.id);
  assert.throws(()=>call('operation',token,{...earn,request_id:'revoked'}),e=>e.status===401);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('existing coin receipts and browser approvals migrate without silently granting star access',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE coin_browser_permissions(owner TEXT NOT NULL,client TEXT NOT NULL,PRIMARY KEY(owner,client)); INSERT INTO coin_browser_permissions VALUES ('alice','lidollquest'); CREATE TABLE coin_game_operations(client TEXT NOT NULL,owner TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(client,owner,id));");
 try {
  const funds={coins:0,stars:0};let store=createCoinApiStore(db,()=>funds,(_owner,asset,delta)=>{funds[asset]+=delta;},()=>true);
  assert.equal(store.browserApproved('alice'),false);
  const call=(method,...args)=>store[method](...args),legacy=connect(call,{id:'alice'},'wallet:read wallet:write');
  const command={kind:'credit',amount:5,request_id:'legacy'},receipt=call('operation',legacy,command);
  // Simulate a pre-upgrade receipt: old coin fingerprints are identical, and old responses omitted asset.
  delete receipt.asset;db.prepare('UPDATE coin_game_operations SET result=?').run(JSON.stringify(receipt));
  store=createCoinApiStore(db,()=>funds,(_owner,asset,delta)=>{funds[asset]+=delta;},()=>true);
  assert.deepEqual(call('operation',legacy,command),receipt);assert.equal(funds.coins,5);
  assert.throws(()=>call('operation',legacy,{...command,asset:'stars'}),e=>e.status===403);
  const browser=store.browserIssue('alice');assert.equal(store.browserApproved('alice'),true);assert.equal(store.browserSession(browser).stars_enabled,true);
 }finally{db.close();}
});

test('star earning caps are independent, persist across connections, and enforce overflow atomically',()=>{
 const db=new DatabaseSync(':memory:');let time=100000;const funds={coins:0,stars:0},ledger=[];
 const apps=coinApps(JSON.stringify([{id:'lidollquest',name:'Game',origins:[],dailyLimit:10,starDailyLimit:3}]));
 const store=createCoinApiStore(db,()=>funds,(_owner,asset,delta)=>{if(funds[asset]+delta>2147483647)throw Object.assign(Error('Overflow'),{status:409});funds[asset]+=delta;ledger.push(delta);},()=>true,apps,()=>time);
 const call=(method,...args)=>store[method](...args);
 try {
  const token=connect(call,{id:'alice'});store.operation(token,{kind:'credit',amount:10,request_id:'coins'});store.operation(token,{asset:'stars',kind:'credit',amount:3,request_id:'stars'});
  const fresh=connect(call,{id:'alice'});
  assert.throws(()=>store.operation(fresh,{asset:'stars',kind:'credit',amount:1,request_id:'above'}),e=>e.code==='daily_limit');
  store.operation(token,{asset:'stars',kind:'debit',amount:1,request_id:'spend'});store.operation(token,{asset:'stars',kind:'refund',original_id:'spend',request_id:'refund'});
  assert.throws(()=>store.operation(fresh,{asset:'stars',kind:'credit',amount:1,request_id:'above'}),e=>e.code==='daily_limit');
  time+=86400000;funds.stars=2147483647;
  assert.throws(()=>store.operation(fresh,{asset:'stars',kind:'credit',amount:1,request_id:'overflow'}),e=>e.status===409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coin_game_operations WHERE id='overflow'").get().n,0);assert.equal(funds.stars,2147483647);
  assert.throws(()=>coinApps(JSON.stringify([{...apps[0],starDailyLimit:1.2}])));
 }finally{db.close();}
});
