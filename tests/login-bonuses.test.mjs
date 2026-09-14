import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {dailyPayout} from '../server/login-bonuses.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
const entry=(id,kind='observation',occurredAt='2026-09-01T12:00:00+00:00')=>({id,kind,occurredAt,...(kind==='observation'?{liquidsMl:100,liquidsMode:'interval',diaperNumber:1}:kind==='wetting'?{category:'bedwetting',position:'laying-down',diaperNumber:1}:{diaperNumber:1,wettingsCount:0})});
const change=entry=>({id:entry.id,entry,baseVersion:0,mutationId:entry.id});
function fixture(){let time=Date.parse('2026-09-01T12:00:00Z');const db=openDatabase(':memory:',{stickerCatalog:[],now:()=>time}),user=db.ensureParticipant('test','a','Alice');return {db,user,setTime:value=>time=Date.parse(value),save:value=>db.sync(user.id,[change(value)]),view:()=>db.economy.loginBonuses(user.id)};}

test('daily schedule grows through coins and diamonds, pays once per account day, and resets after a gap',()=>{
 const f=fixture();try {
  assert.equal(f.view().totalDays,0);
  for(let day=1;day<=8;day++) {
   f.setTime(`2026-09-0${day}T12:00:00Z`);
   const record=entry('day-'+day,['observation','wetting','diaper-change'][day%3]);f.save(record);f.save(record);f.save(entry('extra-'+day));
   assert.equal(f.view().totalDays,day);assert.equal(f.view().streak,day);
   assert.deepEqual(dailyPayout(day),day<=3?{asset:'coins',amount:day*10}:{asset:'diamonds',amount:day-3});
  }
  assert.deepEqual(f.view().earned,{coins:60,diamonds:15});
  assert.equal(f.db.economy.snapshot(f.user.id).wallet.diamonds,15);
  f.setTime('2026-09-10T12:00:00Z');assert.equal(f.view().streak,0);f.save(entry('after-gap'));
  assert.equal(f.view().streak,1);assert.equal(f.view().longestStreak,8);assert.deepEqual(f.view().earned,{coins:70,diamonds:15});
 }finally{f.db.close();}
});

test('edits, deletion, rolls, conflicts and failed batches cannot earn a new check-in; backdated saves count on sync day',()=>{
 const f=fixture();try {
  const original=entry('first');f.save(original);f.setTime('2026-09-02T12:00:00Z');
  f.db.sync(f.user.id,[{...change(original),mutationId:'edit',baseVersion:1,entry:{...original,liquidsMl:200}}]);
  f.save(original);assert.equal(f.view().totalDays,1);
  f.db.sync(f.user.id,[{...change(original),mutationId:'delete',baseVersion:2,entry:null}]);
  f.db.sync(f.user.id,[{...change(original),mutationId:'restore',baseVersion:3}]);
  const occurredAt=original.occurredAt;f.save({id:'roll',kind:'roll',occurredAt,rolledAt:occurredAt,source:'random',result:'hold',rolledResult:'hold',probability:50});
  assert.equal(f.view().totalDays,1);
  assert.throws(()=>f.db.sync(f.user.id,[change(entry('rollback')),{...change(original),entry:{...original,liquidsMl:999}}]));
  assert.equal(f.view().totalDays,1);f.save(entry('backdated'));
  assert.equal(f.view().days.find(day=>day.day==='2026-09-02').checkin.amount,20);
  assert.equal(f.view().days.find(day=>day.day==='2026-09-01').observations,2);
 }finally{f.db.close();}
});

test('enrollment timezone stays pinned across devices, midnight and DST; calendar stats and receipts remain account-scoped',()=>{
 const f=fixture();try {
  f.setTime('2026-11-01T06:59:59Z');const protocol={id:'protocol',kind:'protocol',occurredAt:'2026-10-31T12:00:00-07:00',protocolVersion:1,timeZone:'America/Los_Angeles'};
  f.db.sync(f.user.id,[change(entry('night')),change(protocol)]);
  assert.equal(f.view().today,'2026-10-31');assert.equal(f.view().timeZone,'America/Los_Angeles');
  f.setTime('2026-11-01T07:00:00Z');f.save(entry('midnight','diaper-change'));assert.equal(f.view().streak,2);
  f.setTime('2026-11-01T10:00:00Z');f.save(entry('dst','wetting'));assert.equal(f.view().streak,2);
  f.db.sync(f.user.id,[{...change(protocol),baseVersion:1,mutationId:'zone-edit',entry:{...protocol,timeZone:'UTC'}}]);
  assert.equal(f.view().timeZone,'America/Los_Angeles');
  const bob=f.db.ensureParticipant('test','b','Bob');assert.equal(f.db.economy.loginBonuses(bob.id).totalDays,0);
  for(const range of [{from:'bad'},{from:'2026-02-30'},{from:'2026-01-01',to:'2026-03-01'},{from:'2026-01-02',to:'2026-01-01'}])assert.throws(()=>f.db.economy.loginBonuses(f.user.id,range),e=>e.status===400);
 }finally{f.db.close();}
});

test('diamond conversion is atomic, bounded and retry-safe, and daily outbox replay never pays twice',()=>{
 const directory=mkdtempSync(resolve('artifacts/login-bonus-')),path=resolve(directory,'science.sqlite');let time=Date.parse('2026-09-01T12:00:00Z');
 let db=openDatabase(path,{stickerCatalog:[],now:()=>time});const user=db.ensureParticipant('test','a','Alice');
 try {
  for(let day=1;day<=5;day++){time=Date.parse(`2026-09-0${day}T12:00:00Z`);db.sync(user.id,[change(entry('d'+day,'wetting'))]);}
  assert.deepEqual({...db.economy.snapshot(user.id).wallet},{coins:110,stars:0,diamonds:3});
  const command={action:'diamond-exchange',quantity:2,requestId:'exchange'};const receipt=db.economy.act(user.id,command);
  assert.deepEqual(db.economy.act(user.id,command),receipt);assert.deepEqual({...db.economy.snapshot(user.id).wallet},{coins:210,stars:0,diamonds:1});
  for(const quantity of [0,-1,1.5,'1',42949673])assert.throws(()=>db.economy.act(user.id,{...command,requestId:'bad',quantity}),e=>e.status===400);
  assert.throws(()=>db.economy.act(user.id,{...command,requestId:'overdraw'}),e=>e.status===409);
  assert.throws(()=>db.economy.act(user.id,{...command,quantity:1}),e=>e.status===409);
  const science=new DatabaseSync(path);science.exec("UPDATE reward_outbox SET delivered=0 WHERE asset LIKE 'login-%'");science.close();db.economy.tryFlush();
  assert.deepEqual({...db.economy.snapshot(user.id).wallet},{coins:210,stars:0,diamonds:1});
  db.close();db=openDatabase(path,{stickerCatalog:[],now:()=>time});assert.equal(db.economy.loginBonuses(user.id).streak,5);assert.deepEqual(db.economy.act(user.id,command),receipt);
  const market=new DatabaseSync(resolve(directory,'market.sqlite'));market.prepare('UPDATE economy_wallets SET coins=2147483647 WHERE owner=?').run(user.id);market.close();
  assert.throws(()=>db.economy.act(user.id,{...command,quantity:1,requestId:'overflow'}),e=>e.status===409);assert.equal(db.economy.snapshot(user.id).wallet.diamonds,1);
 }finally{db.close();}
});
