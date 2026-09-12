import test from 'node:test';
import assert from 'node:assert/strict';
import {DESPERATION_LEVELS,validateEntry,validateState,emptyState,toCsv} from '../lib/model.js';
import {openDatabase} from '../server/database.mjs';
import {datasetCsv} from '../lib/admin-format.js';
import {parseAdminImport} from '../server/admin-transfer.mjs';
import {analyzeDataset} from '../lib/admin-analytics.js';
import {trainingState,cooldownRemaining} from '../lib/training.js';
const roll={id:'roll',kind:'roll',occurredAt:'2026-09-12T12:00:00+00:00',rolledAt:'2026-09-12T12:00:00+00:00',result:'hold',rolledResult:'hold',probability:50,source:'random',position:'standing'};
test('roll desperation validates four named levels and keeps old rolls unrecorded',()=>{
  assert.equal(validateEntry(roll).desperation,undefined);
  for(const desperation of DESPERATION_LEVELS) {
    const entry={...roll,desperation};assert.equal(validateEntry(entry).desperation,desperation);
    assert.equal(validateState({...emptyState(),entries:[entry]}).entries[0].desperation,desperation);
    assert.deepEqual(trainingState([entry]),trainingState([roll]));
    assert.equal(cooldownRemaining([entry],new Date(roll.occurredAt)),cooldownRemaining([roll],new Date(roll.occurredAt)));
  }
  for(const desperation of [null,0,'urgent','High','']) assert.throws(()=>validateEntry({...roll,desperation}),/desperation/);
});
test('desperation survives participant sync, JSON/CSV backups and all administrator export formats',()=>{
  const db=openDatabase(':memory:');
  try {
    const user=db.ensureParticipant('https://issuer.example','alice','Alice');
    const entries=DESPERATION_LEVELS.map(desperation=>({...roll,id:desperation,desperation}));
    db.sync(user.id,entries.map(entry=>({id:entry.id,mutationId:entry.id,baseVersion:0,entry})));
    const records=db.records(user.id);
    assert.deepEqual(new Set(records.map(record=>record.entry.desperation)),new Set(DESPERATION_LEVELS));
    const data={format:'little-log-admin',schemaVersion:1,users:[{id:user.id,label:user.label,records,growthChart:{chart:null}}]};
    for(const [format,text] of [['json',JSON.stringify(data)],['csv',datasetCsv(data)],['csv',toCsv(entries)]]) {
      const imported=parseAdminImport({format,text,participantId:user.id});
      assert.deepEqual(new Set(imported[0].records.map(entry=>entry.desperation)),new Set(DESPERATION_LEVELS));
    }
    assert.deepEqual(new Set(db.exportRows().map(entry=>entry.desperation)),new Set(DESPERATION_LEVELS));
    data.users[0].records.push({entry:roll});
    const graph=analyzeDataset(data).graphs.find(graph=>graph.id==='desperation');
    assert.deepEqual(graph.rows,[['Low',1],['Med',1],['High',1],['Crisis',1],['Not recorded',1]]);
    const other=db.ensureParticipant('https://issuer.example','bob','Bob');assert.equal(db.records(other.id).length,0);
  } finally {db.close();}
});
