import { createHash } from 'node:crypto';
import { validateEntry } from '../lib/model.js';
import { validateGrowthChart } from './growth-chart.mjs';
import { parseCsv, csvEntry } from '../lib/admin-format.js';

export function parseAdminImport(input) { // Normalize supported CSV/JSON backups before any database writes; identity mapping is always explicit.
  if(!input || !['json','csv'].includes(input.format) || typeof input.text!=='string' || Buffer.byteLength(input.text)>16*1024*1024) throw Error('Choose a CSV or JSON file of at most 16 MiB.');
  const selected=input.participantId || null;
  const users=new Map();
  function owner(id) {
    if(selected && id && id!==selected) throw Error('This file includes a different participant. Select Everyone to preserve its ownership.');
    id=id || selected;
    if(typeof id!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw Error('Select a user for files without participant IDs.');
    if(!users.has(id)) users.set(id,{id,records:[],chart:null});
    return users.get(id);
  }
  function entry(id,value) {
    if(!value || typeof value!=='object') throw Error('Invalid entry.');
    const candidate={...value};
    if(!candidate.id) candidate.id='import_' + createHash('sha256').update(JSON.stringify(candidate)).digest('hex').slice(0,40);
    const clean=validateEntry(candidate);
    owner(id).records.push(clean);
  }
  function chart(id,value) {
    const user=owner(id);
    if(user.chart) throw Error('Only one chart per participant is allowed in an import.');
    user.chart=validateGrowthChart(value);
  }
  if(input.format==='csv') {
    for(const row of parseCsv(input.text)) {
      if(row.record_type==='participant') owner(row.participant_id);
      else if(row.record_type==='chart') {
        if(!['true','false'].includes(row.chart_escaped)) throw Error('Invalid chart reveal flag.');
        chart(row.participant_id,{name:row.chart_name,since:row.chart_since,refusals:Number(row.chart_refusals),escaped:row.chart_escaped==='true',
          rows:JSON.parse(row.rows_json),stars:JSON.parse(row.stars_json)});
      } else if(!row.record_type || row.record_type==='entry') entry(row.participant_id,csvEntry(row));
      else throw Error('Unknown CSV record type.');
    }
  } else {
    const data=JSON.parse(input.text.replace(/^\uFEFF/,''));
    if(data.format==='little-log-admin' && data.schemaVersion===1 && Array.isArray(data.users)) {
      for(const user of data.users) {
        owner(user.id);
        if(!Array.isArray(user.records)) throw Error('Missing participant records.');
        for(const record of user.records) if(record.entry) entry(user.id,record.entry);
        if(user.growthChart?.chart) chart(user.id,user.growthChart.chart);
      }
    } else if(Array.isArray(data.entries)) {
      for(const value of data.entries) entry(value.participant_id,value.entry_id ? csvEntry(value) : value);
    } else if(Array.isArray(data.charts)) {
      for(const value of data.charts) chart(value.participantId,value.chart);
    } else if(Array.isArray(data.rows) && data.stars) chart(null,data);
    else throw Error('Use a Little Log admin export, observation backup, operator export or chart backup.');
  }
  let count=0;
  for(const user of users.values()) {
    const ids=new Map();
    for(const value of user.records) {
      if(ids.has(value.id) && JSON.stringify(ids.get(value.id))!==JSON.stringify(value)) throw Error('Conflicting duplicate entry IDs in the file.');
      ids.set(value.id,value);
    }
    user.records=[...ids.values()]; count+=user.records.length;
  }
  if(users.size>10000 || count>100000) throw Error('Import exceeds 10,000 users or 100,000 entries.');
  if(!users.size) throw Error('The file contains no importable data.');
  return [...users.values()];
}
