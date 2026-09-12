import assert from 'node:assert/strict';
import test from 'node:test';
import '../potty_chart/merge.js';
import {validateGrowthChart} from '../server/growth-chart.mjs';
const merge=globalThis.mergeGrowthCharts;
const base=()=>({name:'Alice',rows:[{id:'a',label:'Morning',note:'Before breakfast',locked:false},{id:'potty',label:'Locked',note:'',locked:true}],stars:{'2026-09-12:a':true},refusals:2,escaped:false,since:'2026-09-01'});
test('three-way chart merge keeps independent row edits, dated additions/removals and counter increments',()=>{
  const b=base(),local=structuredClone(b),remote=structuredClone(b);
  local.rows[0].label='Morning routine'; local.stars['2026-09-13:a']=true; delete local.stars['2026-09-12:a'];local.refusals++;
  remote.rows[0].note='After breakfast'; remote.stars['2026-09-14:a']=true;remote.refusals+=2;
  const merged=merge({base:b,local,remote});
  assert.equal(merged.rows[0].label,'Morning routine');assert.equal(merged.rows[0].note,'After breakfast');
  assert.deepEqual(merged.stars,{'2026-09-13:a':true,'2026-09-14:a':true}); assert.equal(merged.refusals,5);
  assert.deepEqual(validateGrowthChart(merged),merged);
});
test('simultaneous field edits use the pending local edit, while row deletion cannot erase a remote edit',()=>{
  const b=base(),local=structuredClone(b),remote=structuredClone(b);
  local.name='Local';remote.name='Remote';local.rows=local.rows.filter(row=>row.id!=='a');local.stars={};remote.rows[0].note='Changed remotely';
  const merged=merge({base:b,local,remote});assert.equal(merged.name,'Local');assert.equal(merged.rows[0].note,'Changed remotely');
  const unchanged=merge({base:b,local,remote:b});assert.equal(unchanged.rows.length,1);assert.deepEqual(unchanged.stars,{});
});
test('first link keeps unrelated guest row meanings and stars separate from the saved account chart',()=>{
  const b=base();b.stars={};const local=base(),remote=base();remote.rows[0].label='Different task';
  const merged=merge({base:b,local,remote,initial:true});
  assert.equal(merged.rows.length,3);const guest=merged.rows.find(row=>row.label==='Morning');
  assert.notEqual(guest.id,'a');assert.equal(merged.stars['2026-09-12:a'],true);assert.equal(merged.stars['2026-09-12:'+guest.id],true);
  validateGrowthChart(merged);
  const unused=merge({base:b,local:b,remote,initial:true});assert.equal(unused.rows.length,2);assert.equal(unused.rows[0].label,'Different task');
});
test('automatic merge preserves both inputs and refuses to truncate an oversized combined chart',()=>{
  const b=base(),local=structuredClone(b),remote=structuredClone(b);
  for(let i=0;i<8;i++) {local.rows.push({id:'local'+i,label:'Local',note:'',locked:false});remote.rows.push({id:'remote'+i,label:'Remote',note:'',locked:false});}
  const before=JSON.stringify([local,remote]);assert.throws(()=>merge({base:b,local,remote}),/limit/);assert.equal(JSON.stringify([local,remote]),before);
});
