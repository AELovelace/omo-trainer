import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyState, validateEntry, validateState, toCsv} from '../lib/model.js';
import {deviceState, connectAccount, reconcile} from '../lib/sync.js';
import {openDatabase} from '../server/database.mjs';
import {trainingState} from '../lib/training.js';
import {suggestedDiaperWettings} from '../lib/diapers.js';
import {analyzeDataset} from '../lib/admin-analytics.js';
import {buildXY} from '../lib/chart-builder-model.js';
import {preparePredictionData} from '../lib/prediction.js';

const event=(category,hour='13')=>validateEntry({id:category,kind:'wetting',category,occurredAt:`2026-09-01T${hour}:00:00+00:00`,position:'sitting',diaperNumber:1}); // Use ordinary persisted events to exercise every consumer.
const additions=[event('bedwetting'),event('used-the-potty','14')];
const protocol={id:'enrollment',kind:'protocol',occurredAt:'2026-09-01T12:00:00+00:00',protocolVersion:1,timeZone:'UTC'};

test('new categories survive backups, CSV, server sync, corrections and second-device restore',()=>{
 const state={...emptyState(),entries:additions};
 assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))),state);
 for(const entry of additions)assert.ok(toCsv(state.entries).includes(entry.category));
 const db=openDatabase(':memory:');
 try {
  const person=db.ensureParticipant('issuer','new-categories','Test participant');
  const device=connectAccount(deviceState(state),person,[]);
  const response=db.sync(person.id,device.sync.queue);
  assert.deepEqual(connectAccount(deviceState(emptyState()),person,db.records(person.id)).entries,reconcile(device,response).entries);
  assert.deepEqual(db.exportRows().map(row=>row.category).sort(),additions.map(entry=>entry.category).sort());
  const corrected={...additions[0],category:'used-the-potty',edited:true};
  db.sync(person.id,[{id:corrected.id,mutationId:'correct-category',baseVersion:1,entry:corrected}]);
  assert.deepEqual(db.records(person.id).find(row=>row.id===corrected.id).entry,corrected);
 } finally {db.close();}
});

test('potty use is excluded from diaper suggestions and new labels preserve the existing protocol',()=>{
 assert.equal(suggestedDiaperWettings(additions,'2026-09-01',1),1);
 assert.equal(suggestedDiaperWettings([additions[1]],'2026-09-01',1),0);
 const nextDay=new Date('2026-09-02T00:00:00Z');
 const view=trainingState([protocol,...additions],nextDay);
 assert.equal(view.days[0].bedwetting,1);
 assert.equal(view.days[0]['used-the-potty'],1);
 assert.equal(view.probability,55);
 assert.equal(trainingState([protocol,event('forced'),...additions],nextDay).probability,45);
 assert.equal(preparePredictionData(additions,Number(nextDay)).intervals[0].duration,60);
});

test('analytics count new labels without corrupting ordinal scores or their denominator',()=>{
 const dataset=entries=>({users:[{id:'test',label:'Test',records:entries.map(entry=>({entry}))}]});
 const view=analyzeDataset(dataset(additions));
 for(const entry of additions)assert.equal(view.graphs.find(graph=>graph.id==='classification').rows.find(row=>row[0]===entry.category)[1],1);
 assert.deepEqual(view.graphs.find(graph=>graph.id==='action-score').rows,[]);
 const settings={y:['bedwetting','used-the-potty','action','wettings']};
 assert.deepEqual(buildXY(dataset(additions),settings).rows[0].values,{bedwetting:1,'used-the-potty':1,action:null,wettings:2});
 const mixed=dataset([...additions,event('voluntary','15')]);
 assert.equal(buildXY(mixed,settings).rows[0].values.action,3);
 assert.deepEqual(analyzeDataset(mixed).graphs.find(graph=>graph.id==='action-score').rows,[['2026-09-01',3,1,1]]);
});
