import test from 'node:test';import assert from 'node:assert/strict';
import {preparePredictionData,trainPredictor,forecastPotty} from '../lib/prediction.js';
const minute=60000;
export function diary({days=24,duration=120,fluid=false}={}) { // Independent synthetic days avoid treating overnight silence as a measured interval.
  const entries=[];let id=0,now;
  const add=(kind,time,fields={})=>entries.push({id:'predict-'+(++id),kind,occurredAt:new Date(time).toISOString().replace('.000Z','+00:00'),position:'sitting',diaperNumber:1,category:'voluntary',...fields});
  for(let day=0;day<days;day++){const start=Date.UTC(2026,5,day+1,8),high=fluid&&day%2===0;
    add('observation',start-15*minute,{liquidsMl:0,liquidsMode:'interval'});add('observation',start,{liquidsMl:high?1500:0,liquidsMode:'interval'});add('wetting',start);
    now=start+(fluid?(high?45:300):duration)*minute;add('wetting',now);
  }
  return {entries,now};
}
test('prediction waits for personal evidence and pauses on stale history',()=>{
  assert.equal(forecastPotty(trainPredictor([])).status,'learning');const d=diary({days:7});assert.equal(trainPredictor(d.entries,d.now).kind,'learning');
  const full=diary();const model=trainPredictor(full.entries,full.now);assert.equal(forecastPotty(model,full.now+481*minute).status,'stale');assert.equal(forecastPotty(model,full.now).status,'ready');
});
test('only actual events count; future entries, duplicate IDs, snapshots and long gaps do not train',()=>{
  const d=diary();const original=preparePredictionData(d.entries,d.now);
  const entries=[...d.entries,d.entries[2],{id:'future',kind:'wetting',occurredAt:new Date(d.now+minute).toISOString()},...['roll','diaper-change',undefined].map((kind,i)=>({id:'other'+i,kind,occurredAt:new Date(d.now-10*minute).toISOString(),result:'pee',wettingsCount:900,liquidsMl:800}))];
  const result=preparePredictionData(entries,d.now);assert.deepEqual(result.intervals,original.intervals);assert.equal(result.excluded,23);assert.equal(result.nextFuture,d.now+minute);
  assert.deepEqual(trainPredictor(entries,d.now).weights,trainPredictor(d.entries,d.now).weights);
});
test('personal timing follows short and long diaries, uses elapsed time, and produces coherent probabilities',()=>{
  const short=diary({duration:45}),long=diary({duration:240});const a=trainPredictor(short.entries,short.now),b=trainPredictor(long.entries,long.now);
  assert.ok(forecastPotty(a,short.now).medianMinutes<forecastPotty(b,long.now).medianMinutes);
  const early=forecastPotty(b,long.now),later=forecastPotty(b,long.now+180*minute);assert.ok(later.nextHour>=early.nextHour);
  let sum=0,last=0;for(const bin of later.bins){sum+=bin.probability;assert.ok(bin.probability>=0&&bin.probability<=1);assert.ok(bin.cumulative>=last);last=bin.cumulative;}assert.ok(sum<=1+1e-12);assert.ok(later.fromMinutes<=later.toMinutes);
});
test('drink model requires validation improvement, learns a delay from strong personal signals, and responds to intake',()=>{
  const d=diary({days:70,fluid:true}),model=trainPredictor(d.entries,d.now);
  assert.equal(model.kind,'timing-and-drinks');assert.ok([30,60,120].includes(model.halfLife));assert.ok(model.validation.improvement>=0.05);assert.ok(model.weights[3]>0);
  const dry=forecastPotty({...model,timeline:[]},d.now),wet=forecastPotty({...model,timeline:[{time:d.now,signal:3}]},d.now);
  assert.ok(wet.nextHour>dry.nextHour);assert.ok(wet.medianMinutes<dry.medianMinutes);
  const flat=diary({days:70});assert.equal(trainPredictor(flat.entries,flat.now).kind,'timing');
});
test('untimed intake and cumulative snapshots never become precisely timed drinks',()=>{
  const d=diary({days:1});d.entries[0].liquidsMl=300;d.entries[1].liquidsMl=250;
  const p=preparePredictionData(d.entries,d.now);assert.equal(p.uncertainDrinks,1);assert.equal(p.drinks.length,1);assert.equal(p.drinks[0].ml,250);assert.equal(p.drinks[0].span,15);
});
test('edits, deletion and another profile rebuild independent models without mutating records',()=>{
  const d=diary(),original=JSON.stringify(d.entries),a=trainPredictor(d.entries,d.now);const other=diary({duration:60});const b=trainPredictor(other.entries,other.now);
  assert.equal(JSON.stringify(d.entries),original);assert.notDeepEqual(a.weights,b.weights);
  assert.equal(trainPredictor(d.entries.filter(e=>e.kind!=='wetting'),d.now).kind,'learning');
  const edited=d.entries.map(e=>e.kind==='wetting'&&Date.parse(e.occurredAt)%86400000===10*60*minute?{...e,occurredAt:new Date(Date.parse(e.occurredAt)-60*minute).toISOString()}:e);
  assert.ok(trainPredictor(edited,d.now).medianMinutes<a.medianMinutes);
});
test('sub-15-minute diaries keep fitted parameters and forecasts finite',()=>{
  const d=diary({duration:5}),m=trainPredictor(d.entries,d.now);assert.ok(m.weights.every(Number.isFinite));assert.ok(Number.isFinite(forecastPotty(m,d.now).nextHour));
});
