import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {createCoinApiStore,coinApps} from '../server/coin-api-store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createEconomy} from '../server/economy.mjs';
const connect=(call,owner,scope)=>{const d=call('begin',{client_id:'lidollquest',scope},'test');call('approve',owner,{user_code:d.user_code,approve:true});return call('token',{client_id:'lidollquest',device_code:d.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}).access_token;};
test('upgrading an existing wallet preserves coin/star funds, grants and historical receipts',()=>{
 const db=new DatabaseSync(':memory:');try {
  let economy=createEconomy(db,[]);const call=(method,...args)=>economy.coins[method](...args);
  const token=connect(call,'legacy','wallet:read wallet:write stars:read stars:write');
  const original={kind:'credit',amount:123,request_id:'old-coins'},receipt=call('operation',token,original);
  call('operation',token,{kind:'credit',amount:7,request_id:'old-stars',asset:'stars'});
  db.exec('ALTER TABLE economy_wallets DROP COLUMN diamonds; PRAGMA user_version=8'); // Recreate the prior wallet layout while retaining real grants and operation receipts.
  economy=createEconomy(db,[]);
  assert.deepEqual({...economy.snapshot('legacy').wallet},{coins:123,stars:7,diamonds:0});
  assert.equal(call('balance',token).diamonds,undefined);assert.deepEqual(call('operation',token,original),receipt);
 }finally{db.close();}
});
test('diamonds have explicit consent, isolated balances, bound receipts, whole amounts, debits and one-time refunds',()=>{
 const db=openDatabase(':memory:',{stickerCatalog:[]}),a=db.ensureParticipant('test','a','A'),b=db.ensureParticipant('test','b','B'),call=(method,...args)=>db.economy.coins(method,...args);
 try {
  const full=connect(call,a.id,'wallet:read wallet:write stars:read stars:write diamonds:read diamonds:write'),legacy=connect(call,a.id,'wallet:read wallet:write stars:read stars:write'),read=connect(call,a.id,'diamonds:read'),other=connect(call,b.id,'diamonds:read diamonds:write');
  assert.equal(call('balance',legacy).diamonds,undefined);assert.equal(call('balance',read).balance,undefined);assert.equal(call('balance',read).diamonds_enabled,false);
  const earn={request_id:'earn',kind:'credit',asset:'diamonds',amount:7};
  for(const token of [legacy,read])assert.throws(()=>call('operation',token,earn),e=>e.code==='insufficient_scope');
  const receipt=call('operation',full,earn);assert.equal(receipt.currency,'Diamonds');assert.equal(receipt.balance,7);assert.deepEqual(call('operation',full,earn),receipt);
  assert.equal(call('balance',full).balance,50);assert.equal(call('balance',full).stars,0);assert.equal(call('balance',other).diamonds,0);assert.equal(call('balance',full).diamond_coin_value,50);
  assert.throws(()=>call('operation',full,{...earn,asset:'stars'}),e=>e.status===409);
  for(const amount of [0,-1,.5,'1',2147483648])assert.throws(()=>call('operation',full,{...earn,request_id:'bad',amount}),e=>e.status===400);
  assert.throws(()=>call('operation',full,{...earn,request_id:'overdraw',kind:'debit',amount:8}),e=>e.status===409);
  call('operation',full,{...earn,request_id:'spend',kind:'debit',amount:2});
  const refund={asset:'diamonds',request_id:'refund',kind:'refund',original_id:'spend'};call('operation',full,refund);call('operation',full,refund);
  assert.throws(()=>call('operation',full,{...refund,request_id:'again'}),e=>e.status===409);
  assert.throws(()=>call('operation',other,refund),e=>e.status===409);assert.equal(call('balance',full).diamonds,7);
  assert.equal(db.economy.loginBonuses(a.id).totalDays,0,'External credits never fabricate attendance');
 }finally{db.close();}
});
test('diamond app caps are independent and legacy configurations derive a bounded coin-equivalent default',()=>{
 const apps=coinApps(JSON.stringify([{id:'lidollquest',name:'Game',origins:[],dailyLimit:100,starDailyLimit:3,diamondDailyLimit:2}]));
 assert.equal(coinApps(JSON.stringify([{...apps[0],diamondDailyLimit:undefined}]))[0].diamondDailyLimit,2);
 for(const value of [0,-1,1.5,2147483648])assert.throws(()=>coinApps(JSON.stringify([{...apps[0],diamondDailyLimit:value}])));
 const db=new DatabaseSync(':memory:');let now=Date.now();const funds={coins:0,stars:0,diamonds:0};
 const store=createCoinApiStore(db,()=>funds,(_owner,asset,delta)=>{funds[asset]+=delta;},()=>true,apps,()=>now),call=(method,...args)=>store[method](...args);
 try {
  const token=connect(call,'a','wallet:read wallet:write diamonds:read diamonds:write');
  const input={request_id:'diamonds',kind:'credit',asset:'diamonds',amount:2};call('operation',token,input);
  assert.throws(()=>call('operation',token,{...input,request_id:'over'}),e=>e.code==='daily_limit');
  call('operation',token,{request_id:'coins',kind:'credit',amount:100});
  now+=86400000;call('operation',token,{...input,request_id:'tomorrow'});assert.equal(funds.diamonds,4);
 }finally{db.close();}
});
