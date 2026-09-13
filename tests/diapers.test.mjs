import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntry,emptyState,validateState,toCsv,daySummary } from '../lib/model.js';
import { diaperSummary,diaperAtTime,suggestedDiaperWettings } from '../lib/diapers.js';
import { trainingState,cooldownRemaining } from '../lib/training.js';
import { openDatabase } from '../server/database.mjs';
import { deviceState,connectAccount } from '../lib/sync.js';
import { datasetCsv } from '../lib/admin-format.js';
import { parseAdminImport } from '../server/admin-transfer.mjs';
import { analyzeDataset } from '../lib/admin-analytics.js';

const change=(id='change',day='2026-09-12',count=3,diaper=1)=>({id,kind:'diaper-change',occurredAt:day+'T10:00:00+00:00',diaperNumber:diaper,wettingsCount:count,edited:false});
const wetting=(id,diaper=1)=>({id,kind:'wetting',occurredAt:'2026-09-12T09:00:00+00:00',category:'voluntary',position:'sitting',diaperNumber:diaper,edited:false});

test('diaper changes validate independently and accept dry changes without inventing wetting events',()=>{
  assert.deepEqual(validateEntry({...change(),category:'forced',liquidsMl:500,result:'pee'}),change());
  assert.equal(validateEntry(change('dry','2026-09-12',0)).wettingsCount,0);
  for(const bad of [{wettingsCount:-1},{wettingsCount:1.5},{wettingsCount:10001},{diaperNumber:0},{edited:'yes'}])assert.throws(()=>validateEntry({...change(),...bad}));
  assert.deepEqual(validateState({...emptyState(),entries:[change()]}).entries,[change()]);
  assert.match(toCsv([change()]),/diaper-change/);
  assert.equal(daySummary([change()],'2026-09-12').count,0);
  assert.equal(cooldownRemaining([change()]),0);
  const enrollment={id:'protocol',kind:'protocol',occurredAt:'2026-09-11T00:00:00+00:00',protocolVersion:1,timeZone:'UTC'};
  assert.deepEqual(trainingState([enrollment,change()],new Date('2026-09-13T12:00:00Z')),trainingState([enrollment],new Date('2026-09-13T12:00:00Z')));
});

test('daily change counts, completed-diaper totals and next diaper follow explicit events and corrections',()=>{
  const entries=[wetting('one'),wetting('two'),change(),change('dry','2026-09-12',0,2)];
  assert.deepEqual(diaperSummary(entries,'2026-09-12'),{changes:2,wettings:3,currentDiaper:3});
  assert.deepEqual(diaperSummary(entries,'2026-09-13'),{changes:0,wettings:0,currentDiaper:3});
  assert.equal(diaperSummary([wetting('one',7)],'2026-09-12').changes,0,'A high diaper number is not evidence of changes');
  assert.equal(suggestedDiaperWettings(entries,'2026-09-12',1,'2026-09-12T09:30:00+00:00'),2);
  assert.equal(suggestedDiaperWettings(entries,'2026-09-12',2),0,'Completed counts must not seed the next diaper');
  const legacy={...wetting('old'),wettingsCount:4,occurredAt:'2026-09-12T08:00:00+00:00'};
  assert.equal(suggestedDiaperWettings([legacy,wetting('new')],'2026-09-12',1),5);
  const moved=[entries[0],entries[1],{...change(),occurredAt:'2026-09-11T23:00:00+00:00',edited:true},entries[3]];
  assert.equal(diaperSummary(moved,'2026-09-12').changes,1);
  assert.equal(diaperSummary(moved,'2026-09-11').wettings,3);
});

test('change events persist through sync, participant isolation, correction, deletion and both admin export formats',()=>{
  const db=openDatabase(':memory:');
  try {
    const alice=db.ensureParticipant('issuer','alice','Alice'),bob=db.ensureParticipant('issuer','bob','Bob');
    const entries=[change(),change('dry','2026-09-12',0,2),wetting('one')];
    const device=connectAccount(deviceState({...emptyState(),entries}),alice,[]);
    const result=db.sync(alice.id,device.sync.queue);
    assert.deepEqual(db.sync(alice.id,device.sync.queue).ack,result.ack);
    assert.deepEqual(connectAccount(deviceState(emptyState()),alice,db.records(alice.id)).entries,entries);
    assert.equal(db.records(bob.id).length,0);
    const sql=db.exportRows().find(row=>row.entry_id==='change');
    assert.equal(sql.kind,'diaper-change');assert.equal(sql.wettings_count,3);assert.equal(sql.liquids_ml,null);
    const dataset={format:'little-log-admin',schemaVersion:1,users:[{id:alice.id,label:'Alice',records:db.records(alice.id),growthChart:{chart:null}}]};
    for(const format of ['json','csv'])assert.deepEqual(parseAdminImport({format,text:format==='json'?JSON.stringify(dataset):datasetCsv(dataset)})[0].records,entries);
    const analytics=analyzeDataset(dataset);
    assert.equal(analytics.totals.changes,2);assert.equal(analytics.totals.wettings,1);
    assert.equal(analytics.graphs.find(graph=>graph.id==='completed-diapers').rows[0][1],1.5);
    db.sync(alice.id,[{id:'change',mutationId:'edit',baseVersion:1,entry:{...change(),wettingsCount:5,edited:true}}]);
    assert.equal(diaperSummary(db.records(alice.id).map(row=>row.entry),'2026-09-12').wettings,5);
    db.sync(alice.id,[{id:'dry',mutationId:'delete',baseVersion:1,entry:null}]);
    assert.equal(diaperSummary(db.records(alice.id).map(row=>row.entry).filter(Boolean),'2026-09-12').changes,1);
  }finally{db.close();}
});

 test('automatic wetting assignment follows event-time changes and persists on a new day',()=>{
  const entries=[change(),{...change('second','2026-09-12',2,2),occurredAt:'2026-09-12T10:01:47+00:00'}];
  assert.equal(diaperAtTime(entries,'2026-09-12T09:59:59+00:00'),1,'Backdated wettings precede later changes');
  assert.equal(diaperAtTime(entries,'2026-09-12T10:00:01+00:00'),2);
  assert.equal(diaperAtTime(entries,'2026-09-12T10:01:46+00:00'),2,'Seconds distinguish events within a minute');
  assert.equal(diaperAtTime(entries,'2026-09-12T10:01:47+00:00'),3);
  assert.equal(diaperAtTime(entries,'2026-09-13T00:00:00+00:00'),3);
  assert.equal(diaperAtTime([wetting('historical',4)],'2026-09-12T09:30:00+00:00'),4,'Existing numbered records remain compatible');
});

test('an overnight diaper keeps its number and wettings until an explicit change, including old reset records',()=>{
  const at=(entry,time)=>({...entry,occurredAt:time});
  const entries=[at(change('evening','2026-09-12',4,6),'2026-09-12T22:00:00+00:00'),
    at(wetting('night',7),'2026-09-12T23:00:00+00:00'),at(wetting('morning-reset',1),'2026-09-13T00:01:00+00:00')];
  assert.equal(diaperAtTime(entries,'2026-09-13T00:02:00+00:00'),7);
  assert.deepEqual(diaperSummary(entries,'2026-09-13'),{changes:0,wettings:0,currentDiaper:7});
  assert.equal(suggestedDiaperWettings(entries,'2026-09-13',7),2);
  assert.equal(suggestedDiaperWettings(entries,'2026-09-12',7,'2026-09-12T23:30:00+00:00'),1);
  entries.push(at(change('morning','2026-09-13',2,7),'2026-09-13T08:00:00+00:00'));
  assert.equal(diaperAtTime(entries,'2026-09-13T07:59:00+00:00'),7,'Backdated changes must use their event-time diaper');
  assert.deepEqual(diaperSummary(entries,'2026-09-13'),{changes:1,wettings:2,currentDiaper:1});
  assert.equal(suggestedDiaperWettings(entries,'2026-09-13',1),0);
  entries.push(at(wetting('after-change',1),'2026-09-13T08:00:00+00:00'));
  assert.equal(suggestedDiaperWettings(entries,'2026-09-13',1),1,'Same-second wetting after the change belongs to the new diaper');
  assert.equal(diaperSummary(entries,'2026-09-16').currentDiaper,1,'Several idle days never create changes');
  assert.equal(diaperSummary(entries.filter(e=>e.id!=='morning'),'2026-09-13').changes,0,'Corrections derive from saved events');
});


test('only the first change after a date rollover starts diaper one; later changes increment normally',()=>{
  const entries=[{...wetting('night',5),occurredAt:'2026-09-12T23:00:00+00:00'}];
  assert.equal(diaperAtTime(entries,'2026-09-13T07:00:00+00:00'),5);
  entries.push(change('first','2026-09-13',2,5));
  assert.equal(diaperAtTime(entries,'2026-09-13T10:00:00+00:00'),1);
  assert.equal(entries[1].diaperNumber,5,'The change keeps the identity of the completed overnight diaper');
  entries.push({...change('second','2026-09-13',1,1),occurredAt:'2026-09-13T11:00:00+00:00'});
  assert.equal(diaperAtTime(entries,'2026-09-13T11:00:00+00:00'),2);
  assert.equal(diaperAtTime(entries,'2026-09-16T09:00:00+00:00'),2);
  entries.push(change('next-day','2026-09-16',0,2));
  assert.equal(diaperAtTime(entries,'2026-09-16T10:00:00+00:00'),1);
  assert.deepEqual(diaperSummary(entries,'2026-09-16'),{changes:1,wettings:0,currentDiaper:1});
});
