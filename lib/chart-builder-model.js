import {analyzeDataset,ACTION_SCORES} from './admin-analytics.js';

export const CHART_METRICS=[
 ['observations','Observations','count'],['wettings','Classified wettings','count'],['changes','Diaper changes','count'],
 ['liquids','Logged intake','mL'],['randomRolls','Random rolls','count'],['pee','Pee roll outcomes','count'],['hold','Hold roll outcomes','count'],
 ['probability','Mean saved roll chance','%'],['action','Mean action score','1-5'],['interval','Mean time between wettings','minutes'],
 ['changedWettings','Wettings in changed diapers','count'],['meanChangedWettings','Mean wettings per changed diaper','count'],
 ['diaperNumber','Mean highest diaper number','number'],['stars','Current chart stars','count'],
 ['forced','Forced (F)','count'],['semi-forced','Semi-Forced (SF)','count'],['voluntary','Voluntary (V)','count'],['semi-involuntary','Semi-Involuntary (SI)','count'],['involuntary','Involuntary (I)','count'],
 ['standing','Standing wettings','count'],['sitting','Sitting wettings','count'],['laying-down','Lying-down wettings','count'],
 ['low','Low desperation rolls','count'],['medium','Medium desperation rolls','count'],['high','High desperation rolls','count'],['crisis','Crisis desperation rolls','count']
].map(([id,label,unit])=>({id,label,unit}));
export const CHART_COLORS=['#ff96c8','#88bfff','#7fd9c7','#ffe66f','#b3a4f4','#ffa98a','#eb8cc5','#69bbdb','#9ddd8b','#efd5a0','#c491ef','#dfad99'];
const ids=new Set(CHART_METRICS.map(m=>m.id));
export function chartSettings(input={}) { // Presets contain only allowlisted presentation settings, never cached participant data.
 const y=Array.isArray(input.y)?[...new Set(input.y)].filter(id=>ids.has(id)):['wettings','changes'];
 if(!y.length||y.length>6)throw Error('Choose between one and six Y statistics.');
 return {version:1,title:typeof input.title==='string'?input.title.slice(0,80):'My statistics',x:input.x==='period'||ids.has(input.x)?input.x:'period',y,split:input.split==='participant'?'participant':'combined',scale:input.scale==='normalized'?'normalized':'raw',colors:Object.fromEntries(y.map((id,i)=>[id,/^#[a-f\d]{6}$/i.test(input.colors?.[id]??'')?input.colors[id]:CHART_COLORS[i]]))};
}
const period=(day,interval)=>{
 if(interval==='month')return day.slice(0,7);
 if(interval==='week'){const date=new Date(day+'T12:00:00Z');date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);return date.toISOString().slice(0,10);}
 return day;
};
export const periodTime=label=>Date.parse(label+(label.length===7?'-01':'')+'T00:00:00Z');
function nextPeriod(label,interval){const date=new Date(periodTime(label));if(interval==='month')date.setUTCMonth(date.getUTCMonth()+1);else date.setUTCDate(date.getUTCDate()+(interval==='week'?7:1));return period(date.toISOString().slice(0,10),interval);}
function aggregate(users,filters) { // Reuse the audited intake rules, then add period counts and sample-weighted means from actual events.
 const view=analyzeDataset({users},filters),rows=new Map();
 const get=label=>{if(!rows.has(label))rows.set(label,{period:label,...Object.fromEntries(CHART_METRICS.map(m=>[m.id,['probability','action','interval','meanChangedWettings','diaperNumber','liquids'].includes(m.id)?null:0])),actionSum:0,intervalSum:0,intervalN:0});return rows.get(label);};
 const mappings={activity:['observations','wettings','randomRolls'],intake:['liquids'],outcomes:['pee','hold'],probability:['probability'],changes:['changes'],'completed-diapers':['meanChangedWettings'],diapers:['diaperNumber'],stars:['stars']};
 for(const graph of view.graphs)if(mappings[graph.id])for(const row of graph.rows)mappings[graph.id].forEach((key,i)=>{get(row[0])[key]=row[i+1];});
 for(const {entry} of view.records){const row=get(period(entry.occurredAt.slice(0,10),filters.interval));
  if(entry.kind==='wetting'){row[entry.category]++;row[entry.position]++;row.actionSum+=ACTION_SCORES[entry.category];}
  if(entry.kind==='diaper-change')row.changedWettings+=entry.wettingsCount;
  if(entry.kind==='roll'&&['low','medium','high','crisis'].includes(entry.desperation))row[entry.desperation]++;
 }
 for(const user of users){const wettings=user.records.map(r=>r.entry).filter(e=>e?.kind==='wetting').sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  for(let i=1;i<wettings.length;i++){const entry=wettings[i],day=entry.occurredAt.slice(0,10);if(filters.from&&day<filters.from||filters.to&&day>filters.to)continue;const minutes=(Date.parse(entry.occurredAt)-Date.parse(wettings[i-1].occurredAt))/60000;if(minutes>0){const row=get(period(day,filters.interval));row.intervalSum+=minutes;row.intervalN++;}}
 }
 return [...rows.values()].sort((a,b)=>a.period.localeCompare(b.period)).map(row=>({...row,liquids:row.observations?row.liquids:null,action:row.wettings?row.actionSum/row.wettings:null,interval:row.intervalN?row.intervalSum/row.intervalN:null}));
}
export function buildXY(dataset,input,filters={}) { // X and Y come from the same participant/period; raw values remain intact for exports.
 const settings=chartSettings(input),options={from:filters.from??'',to:filters.to??'',interval:['day','week','month'].includes(filters.interval)?filters.interval:'day'};
 const groups=settings.split==='participant'?dataset.users.map(user=>({id:user.id,label:user.label+' / '+user.id.slice(0,8),users:[user]})):[{id:dataset.users.length===1?dataset.users[0].id:'combined',label:dataset.users.length===1?dataset.users[0].label:'Selected participants',users:dataset.users}];
 if(groups.length*settings.y.length>12)throw Error('This selection would draw more than 12 lines. Choose fewer statistics, one participant, or combined data.');
 const table=[],series=[];
 for(const group of groups){const rows=aggregate(group.users,options);
  for(const row of rows)table.push({participantId:group.id,participant:group.label,period:row.period,x:settings.x==='period'?row.period:row[settings.x],values:Object.fromEntries(settings.y.map(id=>[id,row[id]])),wettingSamples:row.wettings,intervalSamples:row.intervalN});
  for(const metricId of settings.y){const metric=CHART_METRICS.find(m=>m.id===metricId),points=rows.map(row=>({period:row.period,x:settings.x==='period'?periodTime(row.period):row[settings.x],rawY:row[metricId],y:row[metricId]}));
   const valid=points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));const min=Math.min(...valid.map(p=>p.y)),max=Math.max(...valid.map(p=>p.y));
   if(settings.scale==='normalized')for(const point of points)if(Number.isFinite(point.y))point.y=max===min?50:100*(point.y-min)/(max-min);
   if(settings.x!=='period')points.sort((a,b)=>(a.x??Infinity)-(b.x??Infinity)||a.period.localeCompare(b.period));
   points.forEach((point,i)=>{point.breakBefore=settings.x==='period'&&i>0&&nextPeriod(points[i-1].period,options.interval)!==point.period;});
   const index=series.length;series.push({id:group.id+':'+metricId,label:(settings.split==='participant'?group.label+' - ':'')+metric.label,unit:metric.unit,color:settings.split==='participant'?CHART_COLORS[index]:settings.colors[metricId],points});
  }
 }
 return {settings,filters:options,participants:dataset.users.map(user=>({id:user.id,label:user.label})),xLabel:settings.x==='period'?'Recorded '+options.interval:CHART_METRICS.find(m=>m.id===settings.x).label+' ('+CHART_METRICS.find(m=>m.id===settings.x).unit+')',series,rows:table};
}
export function xyCsv(chart) { // Defuse spreadsheet formulas in user labels while retaining raw numeric values and missing cells.
 const cell=value=>'"'+String(typeof value==='string'&&/^[=+\-@\t\r\n']/.test(value)?"'"+value:value??'').replaceAll('"','""')+'"';
 const columns=['Participant ID','Participant','Period','X: '+chart.xLabel,...chart.settings.y.map(id=>{const m=CHART_METRICS.find(m=>m.id===id);return 'Y: '+m.label+' ('+m.unit+')';}),'Wetting samples','Interval samples'];
 return [columns,...chart.rows.map(r=>[r.participantId,r.participant,r.period,r.x,...chart.settings.y.map(id=>r.values[id]),r.wettingSamples,r.intervalSamples])].map(row=>row.map(cell).join(',')).join('\r\n');
}
