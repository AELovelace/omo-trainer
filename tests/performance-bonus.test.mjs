import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {createEconomy} from '../server/economy.mjs';
import {performanceBonus} from '../server/performance-bonus.mjs';
const occurredAt='2026-09-12T12:00:00+00:00';

test('all performance bonuses use their intended whole-number schedule and freeze on first sync',()=>{
 const db=openDatabase(':memory:',{stickerCatalog:[]}),user=db.ensureParticipant('test','bonus','Bonus');
 const cases=[
  [{kind:'observation',liquidsMl:100,liquidsMode:'interval',diaperNumber:1},5],
  ...['forced','semi-forced','voluntary','semi-involuntary','involuntary'].map((category,i)=>[{kind:'wetting',category,position:'sitting',diaperNumber:1},[5,10,15,20,25][i]]),
  ...[0,1,3,10000].map((wettingsCount,i)=>[{kind:'diaper-change',diaperNumber:1,wettingsCount},[5,10,20,50005][i]]),
  ...['hold','pee'].flatMap(result=>['low','medium','high','crisis'].map((desperation,i)=>[{kind:'roll',result,rolledResult:result,source:'random',rolledAt:occurredAt,probability:50,desperation},(result==='pee'?[10,12,14,16]:[5,7,9,11])[i]])),
 ];
 try {
  let expected=0;
  for(const [i,[input,amount]]of cases.entries()) {
   const entry={...input,occurredAt,id:'bonus-'+i},change={id:entry.id,entry,baseVersion:0,mutationId:randomUUID()};
   assert.equal(performanceBonus(entry),amount);
   db.sync(user.id,[change]);db.sync(user.id,[change]);expected+=amount;
   assert.equal(db.economy.snapshot(user.id).wallet.coins,expected);
  }
  const corrected={...cases[1][0],id:'bonus-1',occurredAt,category:'involuntary'};
  db.sync(user.id,[{id:corrected.id,entry:corrected,baseVersion:1,mutationId:randomUUID()}]);
  db.sync(user.id,[{id:'bonus-9',entry:null,baseVersion:1,mutationId:randomUUID()}]);
  db.sync(user.id,[{id:'bonus-9',entry:{...cases[9][0],id:'bonus-9',occurredAt},baseVersion:2,mutationId:randomUUID()}]);
  const snapshot=db.economy.snapshot(user.id);
  assert.equal(snapshot.wallet.coins,expected);
  assert.equal(snapshot.history.filter(row=>row.asset==='coins').length,cases.length);
  assert.ok(snapshot.history.every(row=>Number.isSafeInteger(row.delta)&&row.reason.startsWith('Performance bonus: ')));
  assert.equal(performanceBonus({kind:'protocol'}),0);assert.equal(performanceBonus({result:'pee'}),0);
  assert.equal(performanceBonus({kind:'roll',result:'hold'}),5,'Old rolls with no desperation get no extra bonus');
  assert.equal(performanceBonus({kind:'diaper-change',wettingsCount:-1}),0);
  assert.equal(performanceBonus({kind:'diaper-change',wettingsCount:1.5}),0);
 }finally{db.close();}
});

test('legacy roll receipts migrate without minting coins or rewriting their ledger, and overflow rolls back',()=>{
 const market=new DatabaseSync(':memory:');const source=createHash('sha256').update('old-roll').digest('hex');
 try {
  let economy=createEconomy(market,[]);economy.snapshot('alice');
  market.exec('DROP TABLE performance_rewards'); // Reproduce the previous market schema with one already-issued roll.
  market.prepare('INSERT INTO roll_coin_rewards VALUES (?,?,?,?)').run('alice',source,5,occurredAt);
  market.prepare('UPDATE economy_wallets SET coins=5 WHERE owner=?').run('alice');
  market.prepare('INSERT INTO economy_ledger(operation,owner,asset,delta,reason,created_at) VALUES (?,?,?,?,?,?)').run('roll:'+source,'alice','coins',5,'roll reward',occurredAt);
  economy=createEconomy(market,[]);
  market.exec('BEGIN IMMEDIATE');economy.awardPerformanceBonus('alice',source,16);market.exec('COMMIT');
  assert.equal(economy.snapshot('alice').wallet.coins,5);
  assert.equal(economy.snapshot('alice').history.length,1);assert.equal(economy.snapshot('alice').history[0].reason,'roll reward');
  assert.equal(market.prepare('SELECT amount FROM performance_rewards WHERE source_id=?').get(source).amount,5);
  market.prepare('UPDATE economy_wallets SET coins=2147483647 WHERE owner=?').run('alice');
  market.exec('BEGIN IMMEDIATE');
  assert.throws(()=>economy.awardPerformanceBonus('alice','overflow',5),e=>e.status===409);market.exec('ROLLBACK');
  assert.equal(market.prepare('SELECT COUNT(*) AS n FROM performance_rewards WHERE source_id=?').get('overflow').n,0);
  assert.equal(economy.snapshot('alice').wallet.coins,2147483647);
 }finally{market.close();}
});
