import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {emptyState,validateState,validateEntry,rollProbability,rollResult,toCsv} from '../lib/model.js';
import {trainingState,cooldownRemaining} from '../lib/training.js';
import {csvEntry,parseCsv,datasetCsv} from '../lib/admin-format.js';
import {openDatabase} from '../server/database.mjs';

const at='2026-09-14T12:00:00+00:00',now=Date.parse(at),minute=60000;
const roll=(base=45,draw=99,result='hold')=>({id:randomUUID(),kind:'roll',occurredAt:at,rolledAt:at,result,rolledResult:result,source:'random',desperation:'low',...rollProbability(base,()=>draw,true)});
const protocol=()=>({id:'protocol',kind:'protocol',occurredAt:'2026-09-14T00:00:00+00:00',protocolVersion:1,timeZone:'UTC',lastFailureAt:at,lastFailureDesperationMode:true});

test('desperation halves every final variation, preserves half-percent odds and leaves the protocol base intact',()=>{
  for(const base of [20,45,50,75,80])for(const draw of [0,25,50,99]){
    const normal=rollProbability(base,()=>draw),mode=rollProbability(base,()=>draw,true);
    assert.equal(mode.probability,normal.probability/2);assert.equal(mode.baseProbability,normal.baseProbability);assert.equal(mode.rollRuleVersion,3);
    assert.equal(mode.probabilityModifier,normal.probabilityModifier);const entry=roll(base,draw);assert.deepEqual(validateEntry(entry),entry);
  }
  assert.equal(rollProbability(45,()=>99,true).probability,22.5);
  let pee=0;for(let draw=0;draw<200;draw++)pee+=rollResult(22.5,()=>draw)==='pee';assert.equal(pee,45,'45 of 200 equiprobable outcomes gives 22.5%');
  assert.equal(rollResult(22.5,()=>44),'pee');assert.equal(rollResult(22.5,()=>45),'hold');
  const anchor=protocol();assert.equal(trainingState([anchor,roll(50)],new Date(now)).probability,50);
  assert.equal(trainingState([anchor,roll(50,50)],new Date(now)).probability,60,'The independent +10 modifier still persists');
  assert.equal(trainingState([anchor,roll(50,0)],new Date(now)).probability,50,'The halved guaranteed variation does not change the base');
});

test('mode flags are validated and old backups retain normal mode without invented metadata',()=>{
  const original=roll();
  for(const change of [{desperationMode:'true'},{desperationMode:false},{rollRuleVersion:2},{probability:45},{probability:22.25}])assert.throws(()=>validateEntry({...original,...change}));
  assert.throws(()=>validateEntry({...original,desperationMode:undefined}));
  const old={...original,...rollProbability(45,()=>99)};delete old.desperationMode;assert.deepEqual(validateEntry(old),old);
  assert.equal(cooldownRemaining([old],now),15*minute);
  for(const flag of ['true',1,null])assert.throws(()=>validateEntry({...protocol(),lastFailureDesperationMode:flag}));
  assert.throws(()=>validateEntry({...protocol(),lastFailureAt:undefined}));
  assert.equal(validateState({...emptyState(),settings:{...emptyState().settings,desperationMode:true}}).settings.desperationMode,true);
  assert.throws(()=>validateState({...emptyState(),settings:{...emptyState().settings,desperationMode:'true'}}));
});

test('a desperation Hold retains thirty minutes after mode changes, deletion, reload and another device sync',()=>{
  const entry=roll(),anchor=protocol();assert.equal(cooldownRemaining([entry],now),30*minute);
  assert.equal(cooldownRemaining([entry],now+15*minute),15*minute);assert.equal(cooldownRemaining([entry],now+30*minute-1),1);
  assert.equal(cooldownRemaining([entry],now+30*minute),0);assert.equal(cooldownRemaining([roll(45,99,'pee')],now),0);
  const saved=validateState({...emptyState(),settings:{...emptyState().settings,desperationMode:false},entries:[anchor]});
  assert.equal(cooldownRemaining(saved.entries,now),30*minute,'Disabling mode and deleting the roll cannot clear the protocol deadline');
  const db=openDatabase(':memory:',{stickerCatalog:[]}),user=db.ensureParticipant('test','mode','Mode');
  try{
    db.sync(user.id,[anchor,entry].map(entry=>({id:entry.id,entry,mutationId:randomUUID(),baseVersion:0})));
    db.sync(user.id,[{id:entry.id,entry:null,mutationId:randomUUID(),baseVersion:1}]);
    const remote=db.records(user.id).flatMap(record=>record.entry?[record.entry]:[]);
    assert.equal(cooldownRemaining(remote,now+29*minute),minute);
  }finally{db.close();}
});

test('roll mode, half-percent probabilities and saved deadline flags survive every export and import format',()=>{
  const db=openDatabase(':memory:',{stickerCatalog:[]}),user=db.ensureParticipant('test','exports','Exports'),entries=[protocol(),roll()];
  try{
    db.sync(user.id,entries.map(entry=>({id:entry.id,entry,mutationId:randomUUID(),baseVersion:0})));
    const dataset={users:[{id:user.id,label:user.label,records:db.records(user.id)}]};
    for(const rows of [parseCsv(toCsv(entries)),parseCsv(datasetCsv(dataset)).filter(row=>row.record_type==='entry'),db.exportRows()]){
      const imported=rows.map((row,i)=>validateEntry({id:'import-'+i,...csvEntry(row)}));
      assert.equal(imported.find(entry=>entry.kind==='roll').probability,22.5);assert.equal(imported.find(entry=>entry.kind==='roll').desperationMode,true);
      assert.equal(imported.find(entry=>entry.kind==='protocol').lastFailureDesperationMode,true);assert.equal(cooldownRemaining(imported,now),30*minute);
    }
    const another=validateState(JSON.parse(JSON.stringify({...emptyState(),entries})));assert.deepEqual(another.entries,entries);
  }finally{db.close();}
});
