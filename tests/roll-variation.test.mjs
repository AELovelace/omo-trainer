import test from 'node:test';
import assert from 'node:assert/strict';
import {rollProbability,rollResult,validateEntry,toCsv} from '../lib/model.js';
import {csvEntry,parseCsv,datasetCsv} from '../lib/admin-format.js';
import {openDatabase} from '../server/database.mjs';
const entry=variation=>({id:'varied',kind:'roll',occurredAt:'2026-09-12T12:00:00+00:00',rolledAt:'2026-09-12T12:00:00+00:00',source:'random',result:'pee',rolledResult:'pee',...variation});

test('modifier buckets have exact frequencies and persistent-base bounds',()=>{
 for(const base of [20,50,80]) {
  const draws=Array.from({length:1000},(_,i)=>rollProbability(base,()=>i)),counts={};
  for(const draw of draws)counts[draw.probabilityModifier]=(counts[draw.probabilityModifier]??0)+1;
  assert.deepEqual(counts,{guaranteed:25,decrease:25,increase:25,none:925});
  assert.equal(draws[0].rollRuleVersion,2);
  assert.equal(draws[25].probability,Math.max(20,base-10));assert.equal(draws[50].probability,Math.min(80,base+10));
  assert.equal(rollResult(draws[0].probability,()=>{throw Error('Guaranteed roll must not draw again');}),'pee');
 }
 const values=[4294967295,4294967000,50];assert.equal(rollProbability(50,()=>values.shift()).probability,60);
 assert.equal(values.length,0,'Modifier uses unbiased rejection sampling');
});

test('versioned roll metadata validates effective chances and retains old rolls without invented modifiers',()=>{
 for(const base of [20,50,80])for(const draw of [0,25,50,99]) {
  const original=entry(rollProbability(base,()=>draw));assert.deepEqual(validateEntry(original),original);
 }
 const legacy=entry({probability:50});assert.deepEqual(validateEntry(legacy),legacy);
 for(const override of [{probability:90},{baseProbability:50},{probabilityModifier:'increase'},{rollRuleVersion:3}])assert.throws(()=>validateEntry({...legacy,...override}));
 assert.throws(()=>validateEntry({...entry(rollProbability(50,()=>50)),probability:50}));
 assert.throws(()=>validateEntry({...entry(rollProbability(50,()=>0)),result:'hold',rolledResult:'hold'}));
});

test('adjusted probabilities survive database sync and participant, admin, and operator exports',()=>{
 const db=openDatabase(':memory:',{stickerCatalog:[]}),user=db.ensureParticipant('test','variation','Variation');
 try {
  const entries=[0,5,10,99].map((draw,i)=>({...entry(rollProbability(i===1?20:80,()=>draw)),id:'roll-'+i}));
  db.sync(user.id,entries.map(e=>({id:e.id,entry:e,mutationId:e.id,baseVersion:0})));
  assert.deepEqual(db.records(user.id).map(r=>r.entry).sort((a,b)=>a.id.localeCompare(b.id)),entries);
  const csv=toCsv(entries),admin=datasetCsv({users:[{id:user.id,label:'Variation',records:entries.map(entry=>({entry}))}]});
  for(const rows of [parseCsv(csv),parseCsv(admin).filter(r=>r.record_type==='entry'),db.exportRows()]) {
   const imported=rows.map((r,i)=>validateEntry({id:'csv-'+i,...csvEntry(r)}));
   assert.deepEqual(imported.map(({probability,baseProbability,probabilityModifier,rollRuleVersion})=>({probability,baseProbability,probabilityModifier,rollRuleVersion})).sort((a,b)=>a.probability-b.probability),entries.map(({probability,baseProbability,probabilityModifier,rollRuleVersion})=>({probability,baseProbability,probabilityModifier,rollRuleVersion})).sort((a,b)=>a.probability-b.probability));
  }
 }finally{db.close();}
});


test('persistent bonuses replay alongside daily changes and guaranteed/version-1 rolls leave the base alone',async()=>{
 const {trainingState}=await import('../lib/training.js');
 const protocol={id:'protocol',kind:'protocol',protocolVersion:1,timeZone:'UTC',occurredAt:'2026-09-12T00:00:00+00:00'};
 const increase={...entry(rollProbability(50,()=>50)),id:'up'};
 const guaranteed={...entry(rollProbability(60,()=>0)),id:'guaranteed',occurredAt:'2026-09-12T13:00:00+00:00',rolledAt:'2026-09-12T13:00:00+00:00'};
 const old={...increase,id:'old',rollRuleVersion:1};
 assert.equal(trainingState([protocol,increase,guaranteed,old],new Date('2026-09-12T14:00:00Z')).probability,60);
 assert.equal(trainingState([protocol,guaranteed,old,increase],new Date('2026-09-13T01:00:00Z')).probability,65,'Empty completed day adds its normal five points');
 const wetting={id:'wet',kind:'wetting',category:'forced',occurredAt:'2026-09-12T14:00:00+00:00'};
 assert.equal(trainingState([protocol,increase,guaranteed,wetting],new Date('2026-09-13T01:00:00Z')).probability,55,'Daily -5 still applies after the persistent +10');
 assert.equal(trainingState([protocol,increase],new Date('2026-09-12T11:00:00Z')).probability,50,'Future random events do not change the current base');
});
