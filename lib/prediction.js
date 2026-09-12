const MINUTE=60000,DAY=1440*MINUTE;
export const PREDICTION_VERSION=1;
export const PREDICTION_LIMITS=Object.freeze({days:90,intervals:360,minIntervals:8,minDays:3,maxGap:480,step:15,horizon:480});
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2;};
const sigmoid=x=>1/(1+Math.exp(-Math.max(-20,Math.min(20,x))));

export function preparePredictionData(entries,now=Date.now()) { // Only actual, already-recorded events train this user's model; rolls and change totals never become wettings.
  now=Number(now);const seen=new Set();let nextFuture=Infinity;
  const records=entries.filter(entry=>{const time=Date.parse(entry.occurredAt);if(time>now){nextFuture=Math.min(nextFuture,time);return false;}if(!Number.isFinite(time)||time<now-90*DAY||seen.has(entry.id))return false;seen.add(entry.id);return true;}).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const wettings=records.filter(e=>e.kind==='wetting').map(e=>({time:Date.parse(e.occurredAt),day:e.occurredAt.slice(0,10)}));
  const intervals=[];let excluded=0;
  for(let i=1;i<wettings.length;i++){const start=wettings[i-1].time,end=wettings[i].time,duration=(end-start)/MINUTE;
    if(duration<5||duration>PREDICTION_LIMITS.maxGap){excluded++;continue;} // Long gaps may contain sleep or missing records; same-minute duplicates cannot define an interval.
    intervals.push({start,end,duration,day:wettings[i].day});
  }
  const observations=records.filter(e=>e.kind==='observation'&&e.liquidsMode==='interval');
  const drinks=[];let uncertainDrinks=records.filter(e=>e.kind===undefined&&e.liquidsMl>0).length;
  for(let i=0;i<observations.length;i++){const entry=observations[i],time=Date.parse(entry.occurredAt),ml=entry.liquidsMl;
    const span=i?(time-Date.parse(observations[i-1].occurredAt))/MINUTE:Infinity;
    if(!(ml>0)||!Number.isFinite(ml))continue;
    if(span<=0||span>360){uncertainDrinks++;continue;} // A first check-in or a long reporting gap has no reliable drink timing.
    drinks.push({time,ml,span});
  }
  return {intakeReports:observations.map(e=>({time:Date.parse(e.occurredAt),ml:e.liquidsMl})),intervals:intervals.slice(-360),drinks,excluded,uncertainDrinks,nextFuture,lastWetting:wettings.at(-1)?.time??null,
    recentMl:observations.filter(e=>Date.parse(e.occurredAt)>=now-360*MINUTE).reduce((sum,e)=>sum+e.liquidsMl,0)};
}

function fluidTimeline(drinks,halfLife) { // Uniform intake within each reported interval approximates unknown drink times; reports become available only at their check-in time.
  const k=Math.LN2/halfLife;let signal=0,previous=0;
  return drinks.map(drink=>{signal*=Math.exp(-k*(drink.time-previous)/MINUTE);signal+=(drink.ml/500)*(1-Math.exp(-k*drink.span))/(k*drink.span);previous=drink.time;return {time:drink.time,signal};});
}
function fluidAt(timeline,at,halfLife) { // Binary search keeps training bounded even for large imported histories.
  let low=0,high=timeline.length;while(low<high){const middle=(low+high)>>1;if(timeline[middle].time<=at)low=middle+1;else high=middle;}
  const point=timeline[low-1];return point?point.signal*Math.exp(-Math.LN2*(at-point.time)/MINUTE/halfLife):0;
}
const features=(elapsed,fluid)=>[1,Math.min(4,elapsed/120),Math.log1p(elapsed/30),Math.min(4,fluid)];
const risk=(weights,x)=>sigmoid(weights.reduce((sum,w,i)=>sum+w*x[i],0));
function rowsFor(intervals,timeline,halfLife) { // Each target asks whether an actual wetting occurs in the next 15 minutes, using only data available at the start of that bin.
  const rows=[];
  for(const interval of intervals)for(let elapsed=0;elapsed<interval.duration;elapsed+=15){const at=interval.start+elapsed*MINUTE;rows.push({x:features(elapsed,halfLife?fluidAt(timeline,at,halfLife):0),y:interval.duration-elapsed<=15?1:0});}
  return rows;
}
function fit(rows,fluid=false) { // Regularized discrete-time survival model; nonnegative effects keep elapsed time and extra intake from reducing the estimated hazard.
  const rate=Math.max(0.001,Math.min(0.999,mean(rows.map(r=>r.y)))),weights=[Math.log(rate/(1-rate)),0,0,0];
  for(let iteration=0;iteration<160;iteration++){
    const gradient=[0,0,0,0];for(const row of rows){const error=risk(weights,row.x)-row.y;for(let j=0;j<4;j++)gradient[j]+=error*row.x[j];}
    for(let j=0;j<4;j++){weights[j]-=0.35*(gradient[j]/rows.length+(j?0.003*weights[j]:0));if(j)weights[j]=Math.max(0,weights[j]);}if(!fluid)weights[3]=0;
  }
  return weights;
}
const brier=(rows,weights)=>mean(rows.map(row=>(risk(weights,row.x)-row.y)**2));

export function trainPredictor(entries,now=Date.now()) { // Rebuild from this account's synced/local records; no population model, credentials, or health data leave the device.
  now=Number(now);const data=preparePredictionData(entries,now),intervals=data.intervals,n=intervals.length,days=new Set(intervals.map(i=>i.day)).size;
  const model={version:PREDICTION_VERSION,trainedAt:now,...data,n,days,medianMinutes:n?median(intervals.map(i=>i.duration)):null,meanMinutes:n?mean(intervals.map(i=>i.duration)):null,kind:'learning',halfLife:null,validation:null,evidence:'Limited'};
  if(n<8||days<3)return model;
  const baselineRows=rowsFor(intervals,[],null);let selected=null;
  if(n>=30&&days>=7){ // Choose the fluid delay on a chronological validation set, never a random split that leaks future history.
    const split=Math.floor(n*0.75),training=intervals.slice(0,split),validation=intervals.slice(split);
    const baseWeights=fit(rowsFor(training,[],null)),baseScore=brier(rowsFor(validation,[],null),baseWeights);
    model.validation={intervals:validation.length,baselineBrier:baseScore,brier:baseScore,improvement:0};
    if(data.drinks.length>=20)for(const halfLife of [30,60,120]){
      const timeline=fluidTimeline(data.drinks,halfLife),trainRows=rowsFor(training,timeline,halfLife);
      if(mean(trainRows.map(r=>r.x[3]**2))-mean(trainRows.map(r=>r.x[3]))**2<0.02)continue;
      const weights=fit(trainRows,true),score=brier(rowsFor(validation,timeline,halfLife),weights);
      if(weights[3]>0&&score<baseScore*0.95&&(!selected||score<selected.score))selected={halfLife,score,timeline};
    }
    if(selected)model.validation={...model.validation,brier:selected.score,improvement:1-selected.score/baseScore};
    if(n>=60&&days>=14)model.evidence='Moderate'; // Evidence describes diary coverage, not clinical validation or a guaranteed confidence level.
  }
  model.kind=selected?'timing-and-drinks':'timing';model.halfLife=selected?.halfLife??null;model.timeline=selected?.timeline??[];
  model.weights=fit(selected?rowsFor(intervals,selected.timeline,selected.halfLife):baselineRows,Boolean(selected));
  return model;
}

export function forecastPotty(model,now=Date.now()) { // Condition the forecast on no new wetting since the last record; never invent future drinks or silently restart an overdue clock.
  now=Number(now);const elapsed=(now-model.lastWetting)/MINUTE;
  if(model.kind==='learning'||model.lastWetting===null)return {status:'learning',bins:[]};
  if(elapsed<0||elapsed>480)return {status:'stale',bins:[]};
  const initialFluid=model.halfLife?fluidAt(model.timeline,now,model.halfLife):0;
  let survival=1;const bins=[];
  for(let offset=0;offset<480;offset+=15){const fluid=model.halfLife?initialFluid*Math.exp(-Math.LN2*offset/model.halfLife):0;
    const hazard=risk(model.weights,features(elapsed+offset,fluid)),probability=survival*hazard;survival*=1-hazard;bins.push({from:offset,to:offset+15,probability,cumulative:1-survival});}
  const quantile=p=>bins.find(bin=>bin.cumulative>=p)?.to??null;
  const peak=bins.reduce((best,bin)=>bin.probability>best.probability?bin:best,bins[0]);
  return {status:'ready',elapsed,fromMinutes:quantile(0.2),toMinutes:quantile(0.8),medianMinutes:quantile(0.5),peak,nextHour:bins[3].cumulative,bins};
}
