import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createEconomy} from '../server/economy.mjs';

function fixture(){ // Use a real pair of temporary databases to exercise registration, delayed delivery and reopening.
  const directory=mkdtempSync(join(tmpdir(),'registration-bonus-')),filename=join(directory,'science.sqlite'),marketPath=join(directory,'market.sqlite');
  return {directory,filename,marketPath,open:()=>openDatabase(filename,{stickerCatalog:[]}),clean:()=>rmSync(directory,{recursive:true,force:true})};
}

test('new accounts receive 50 coins once; spending, repeat sign-ins, renamed profiles and restarts never refill them',()=>{
  const f=fixture();let db=f.open();
  try{
    const user=db.ensureParticipant('issuer','new','New'),initial=db.economy.snapshot(user.id);
    assert.deepEqual({...initial.wallet},{coins:50,stars:0,diamonds:0});assert.equal(initial.bank.coins,0);assert.equal(initial.bank.issuedCoins,0);
    assert.equal(initial.history.length,1);assert.equal(initial.history[0].reason,'Welcome bonus: 50 lid0llcoins');assert.equal(initial.history[0].delta,50);
    assert.equal(db.records(user.id).length,0);assert.equal(db.economy.loginBonuses(user.id).totalDays,0,'Registration does not invent a daily check-in');
    const token=db.economy.coins('browserIssue',user.id);assert.equal(db.economy.coins('balance',token).balance,50,'Authorized wallet clients see the starting grant');
    db.economy.coins('operation',token,{request_id:'spend-starting-funds',kind:'debit',amount:30});
    assert.equal(db.ensureParticipant('issuer','new','Renamed').id,user.id);assert.equal(db.economy.snapshot(user.id).wallet.coins,20);
    db.close();db=f.open();assert.equal(db.ensureParticipant('issuer','new','Renamed again').id,user.id);
    const saved=db.economy.snapshot(user.id);assert.equal(saved.wallet.coins,20);assert.equal(saved.history.filter(row=>row.reason.startsWith('Welcome bonus:')).length,1);
    const other=db.ensureParticipant('issuer','second-new','Renamed again');assert.notEqual(other.id,user.id);assert.equal(db.economy.snapshot(other.id).wallet.coins,50);
  }finally{db.close();f.clean();}
});

test('upgrading leaves existing balances and existing accounts without wallets unchanged',()=>{
  const f=fixture();let db=f.open();db.close();
  const science=new DatabaseSync(f.filename),market=new DatabaseSync(f.marketPath);
  try{
    const insert=science.prepare('INSERT INTO participants(id,label,issuer,subject,created_at) VALUES (?,?,?,?,?)');
    for(const id of ['existing','no-wallet'])insert.run(id,id,'issuer',id,'2025-01-01T00:00:00Z');
    const economy=createEconomy(market,[]);economy.snapshot('existing');market.prepare('UPDATE economy_wallets SET coins=37,stars=4,diamonds=2 WHERE owner=?').run('existing');
    market.exec('DROP TABLE registration_rewards'); // Represent a deployment made before the welcome-grant migration.
  }finally{science.close();market.close();}
  db=f.open();
  try{
    db.ensureParticipant('issuer','existing','Existing');db.ensureParticipant('issuer','no-wallet','First market visit');
    assert.deepEqual({...db.economy.snapshot('existing').wallet},{coins:37,stars:4,diamonds:2});
    assert.deepEqual({...db.economy.snapshot('no-wallet').wallet},{coins:0,stars:0,diamonds:0});
    assert.equal(db.economy.snapshot('existing').history.length,0);assert.equal(db.economy.snapshot('no-wallet').history.length,0);
    const fresh=db.ensureParticipant('issuer','fresh','Fresh');assert.equal(db.economy.snapshot(fresh.id).wallet.coins,50);
  }finally{db.close();f.clean();}
});

test('a market outage cannot lose a new registration grant, and delivery replay cannot duplicate its credit',()=>{
  const f=fixture();let db=f.open();const seed=db.ensureParticipant('issuer','seed','Seed');
  const lock=new DatabaseSync(f.marketPath),science=new DatabaseSync(f.filename);let locked=false;
  try{
    lock.exec('BEGIN IMMEDIATE');locked=true;
    const user=db.ensureParticipant('issuer','during-outage','New during outage');
    assert.ok(db.createSession(user.id));
    const entitlement=science.prepare("SELECT amount,delivered FROM reward_outbox WHERE owner=? AND asset='registration-coins'").get(user.id);
    assert.deepEqual({...entitlement},{amount:50,delivered:0});
    lock.exec('ROLLBACK');locked=false;
    const token=db.economy.coins('browserIssue',user.id);assert.equal(db.economy.coins('balance',token).balance,50);
    science.prepare("UPDATE reward_outbox SET delivered=0 WHERE owner=? AND asset='registration-coins'").run(user.id); // Replay the crash window after market commit but before the outbox acknowledgement.
    db.close();db=f.open();db.ensureParticipant('issuer','during-outage','Still the same account');db.economy.tryFlush();
    const saved=db.economy.snapshot(user.id);assert.equal(saved.wallet.coins,50);assert.equal(saved.history.length,1);assert.equal(db.economy.snapshot(seed.id).wallet.coins,50);
    assert.equal(lock.prepare('SELECT count(*) AS n FROM registration_rewards WHERE owner=?').get(user.id).n,1);
    assert.equal(science.prepare("SELECT delivered FROM reward_outbox WHERE owner=? AND asset='registration-coins'").get(user.id).delivered,1);
  }finally{if(locked)lock.exec('ROLLBACK');lock.close();science.close();db.close();f.clean();}
});
