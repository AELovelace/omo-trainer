import { isObservation, isRoll, liquidTotal, WETTING_CATEGORIES, DESPERATION_LEVELS, DESPERATION_LABELS } from './model.js';
import { trainingState } from './training.js';

export const ACTION_SCORES=Object.freeze({'forced':1,'semi-forced':2,'voluntary':3,'semi-involuntary':4,'involuntary':5}); // Explicit ordinal coding for descriptive analysis; saved categories remain unchanged.
const actionLabels=['Forced (F)','Semi-Forced (SF)','Voluntary (V)','Semi-Involuntary (SI)','Involuntary (I)'];
const positionLabels={'standing':'Standing','sitting':'Sitting','laying-down':'Lying down'};

export function analyzeDataset(dataset, {from='',to='',interval='day',timeBinHours=6}={}) { // Compute descriptive statistics per participant before aggregating; cumulative snapshots never become extra events.
  if(![3,6].includes(timeBinHours))throw new Error('Choose 3- or 6-hour time groups.');
  const positionActions=new Map(Object.keys(positionLabels).map(position=>[position,[0,0,0,0,0]]));
  const timeActions=Array.from({length:24/timeBinHours},()=>[0,0,0,0,0]),actionDays=new Map();
  const inside=day=>(!from || day>=from) && (!to || day<=to);
  const records=[], participantDays=new Map(), buckets=new Map(), chartDays=new Map(), chartRows=[], summaries=[];
  const desperationCounts=new Map([...DESPERATION_LEVELS.map(level=>[level,0]),['unrecorded',0]]);
  const categoryCounts=Object.fromEntries(WETTING_CATEGORIES.map(value=>[value,0]));
  const positions=new Map(), hours=Array.from({length:24},()=>0), weekdays=Array.from({length:7},()=>0), calibration=new Map();
  const kinds=new Map(), sources=new Map(), zones=new Map(), edits=new Map([['Edited',0],['Unedited',0]]);
  let totalLiquids=0, probabilitySum=0, probabilityCount=0, randomRolls=0, wettings=0, observations=0, stars=0, changes=0;
  const dayKey=day=>{
    if(interval==='month') return day.slice(0,7);
    if(interval==='week') { const date=new Date(day+'T12:00:00Z'); date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7); return date.toISOString().slice(0,10); }
    return day;
  };
  const bin=day=>{
    const key=dayKey(day);
    if(!buckets.has(key)) buckets.set(key,{label:key,observations:0,wettings:0,rolls:0,liquids:0,pee:0,hold:0,probability:0,probabilityN:0,diapers:0,diaperN:0,reportedWettings:0,reportedN:0,changes:0,changedWettings:0});
    return buckets.get(key);
  };
  for(const user of dataset.users) {
    const entries=user.records.filter(record=>record.entry).map(record=>record.entry);
    const counts={observations:0,wettings:0,rolls:0,liquids:0,stars:0,changes:0};
    for(const entry of entries) {
      const day=entry.occurredAt.slice(0,10);
      if(!inside(day)) continue;
      const bucket=bin(day);
      records.push({participantId:user.id,participant:user.label,entry});
      const kind=entry.kind ?? 'legacy snapshot'; kinds.set(kind,(kinds.get(kind)??0)+1);
      if(entry.kind==='protocol') { zones.set(entry.timeZone,(zones.get(entry.timeZone)??0)+1); continue; }
      const key=user.id+':'+day;
      if(!participantDays.has(key)) participantDays.set(key,{user:user.label,id:user.id,day,entries:[]});
      participantDays.get(key).entries.push(entry);
      if(isObservation(entry)) { observations++; counts.observations++; bucket.observations++; }
      if(entry.kind==='diaper-change') { changes++; counts.changes++; bucket.changes++; bucket.changedWettings+=entry.wettingsCount; }
      if(entry.kind==='wetting') {
        wettings++; counts.wettings++; bucket.wettings++; categoryCounts[entry.category]++;
        positions.set(entry.position,(positions.get(entry.position)??0)+1);
        const score=ACTION_SCORES[entry.category],hour=Number(entry.occurredAt.slice(11,13));
        if (score !== undefined) { // Bedwetting and potty use are separate labels with no invented ordinal score.
          positionActions.get(entry.position)[score-1]++;
          timeActions[Math.floor(hour/timeBinHours)][score-1]++;
          const daily=actionDays.get(day)??{sum:0,n:0,participants:new Set()};
          daily.sum+=score;daily.n++;daily.participants.add(user.id);actionDays.set(day,daily);
        }
        hours[Number(entry.occurredAt.slice(11,13))]++;
        weekdays[(new Date(day+'T12:00:00Z').getUTCDay()+6)%7]++;
      }
      if(entry.kind==='roll') { const level=entry.desperation??'unrecorded'; desperationCounts.set(level,desperationCounts.get(level)+1); }
      if(isRoll(entry)) {
        sources.set(entry.source,(sources.get(entry.source)??0)+1);
        if(entry.source==='random') {
          randomRolls++; counts.rolls++; bucket.rolls++;
          const result=entry.rolledResult??entry.result; bucket[result]++;
          probabilitySum+=entry.probability; probabilityCount++;
          bucket.probability+=entry.probability; bucket.probabilityN++;
          const c=calibration.get(entry.probability)??{n:0,pee:0}; c.n++; c.pee+=Number(result==='pee'); calibration.set(entry.probability,c);
        }
      }
      if(entry.edited!==undefined) edits.set(entry.edited?'Edited':'Unedited',edits.get(entry.edited?'Edited':'Unedited')+1);
    }
    const chart=user.growthChart?.chart;
    if(chart) for(const row of chart.rows) {
      const dates=Object.keys(chart.stars).filter(key=>key.split(':')[1]===row.id).map(key=>key.split(':')[0]).filter(inside);
      for(const day of dates) { const key=dayKey(day); chartDays.set(key,(chartDays.get(key)??0)+1); }
      stars+=dates.length; counts.stars+=dates.length;
      chartRows.push([user.label,user.id,row.id,row.label,row.note,dates.length,row.locked?'Locked':'Editable']);
    }
    const protocol=trainingState(entries);
    summaries.push({id:user.id,label:user.label,...counts,probability:protocol.protocol?protocol.probability:null,
      enrolled:protocol.protocol?.occurredAt??'',timezone:protocol.protocol?.timeZone??'',refusals:chart?.refusals??null,
      revealed:chart?chart.escaped:null,chartSince:chart?.since??'',chartUpdated:user.growthChart?.updatedAt??''});
  }
  const scatter=[];
  for(const value of participantDays.values()) {
    const liquids=liquidTotal(value.entries), bucket=bin(value.day), count=value.entries.filter(entry=>entry.kind==='wetting').length;
    totalLiquids+=liquids; bucket.liquids+=liquids;
    summaries.find(user=>user.id===value.id).liquids+=liquids;
    const diaperValues=value.entries.flatMap(entry=>entry.diaperNumber===undefined?[]:[entry.diaperNumber]);
    if(diaperValues.length) { bucket.diapers+=Math.max(...diaperValues); bucket.diaperN++; }
    const byDiaper=new Map();
    for(const entry of value.entries) if(entry.kind!=='diaper-change' && entry.wettingsCount!==undefined && entry.diaperNumber!==undefined) byDiaper.set(entry.diaperNumber,Math.max(byDiaper.get(entry.diaperNumber)??0,entry.wettingsCount));
    if(byDiaper.size) { bucket.reportedWettings+=[...byDiaper.values()].reduce((sum,n)=>sum+n,0); bucket.reportedN+=byDiaper.size; }
    if(value.entries.some(isObservation)) scatter.push([value.user+' / '+value.day,liquids,count]);
  }
  const days=[...buckets.values()].sort((a,b)=>a.label.localeCompare(b.label)), graphs=[];
  const graph=(id,title,description,type,columns,rows)=>graphs.push({id,title,description,type,columns,rows});
  graph('activity','Recorded activity','Observations, actual classified events and random draws are counted separately. Legacy combined snapshots can contribute an observation and a draw.','line',['Period','Observations','Wettings','Random rolls'],days.map(d=>[d.label,d.observations,d.wettings,d.rolls]));
  graph('intake','Logged liquid intake','mL summed across participant-days. Legacy cumulative intake uses its maximum plus later interval entries; unlogged intake is unknown.','bar',['Period','mL'],days.map(d=>[d.label,d.liquids]));
  graph('classification','Wetting classifications','Each classified wetting contributes exactly one event. SF is kept separate for analysis.','bar',['Classification','Events'],Object.entries(categoryCounts));
  graph('position-action','Action by position','Counts of F, SF, V, SI and I events, split by position and action. Bedwetting and potty use appear in the classification chart. Exact data includes the total for each position.','bar',['Position',...actionLabels,'Total'],[...positionActions].map(([position,counts])=>[positionLabels[position],...counts,counts.reduce((a,b)=>a+b,0)]));
  graphs.at(-1).plotColumns=[1,2,3,4,5];
  const hourLabel=hour=>String(hour).padStart(2,'0')+':00';
  graph('time-action','Action by time of day','Counts of F, SF, V, SI and I events in '+timeBinHours+'-hour groups using recorded local time for each event. Start inclusive, end exclusive; unlogged events are unknown.','bar',['Local time',...actionLabels,'Total'],timeActions.map((counts,i)=>[hourLabel(i*timeBinHours)+' to '+hourLabel((i+1)*timeBinHours),...counts,counts.reduce((a,b)=>a+b,0)]));
  graphs.at(-1).plotColumns=[1,2,3,4,5];
  graph('action-score','Daily action score','F=1, SF=2, V=3, SI=4, I=5. Bedwetting and potty use have no score and are excluded. Daily event-weighted mean for the selected participants; choose one participant for an individual trend. Ordinal category spacing is assumed, not measured. This describes recorded actions, not proof of training effectiveness. Always grouped by day; missing days have gaps.','line',['Day','Mean action score','Classified wettings','Participants'],[...actionDays].sort((a,b)=>a[0].localeCompare(b[0])).map(([day,value])=>[day,value.sum/value.n,value.n,value.participants.size]));
  Object.assign(graphs.at(-1),{plotColumns:[1],yDomain:[1,5],dateAxis:true,breakOnDayGap:true,xLabel:'Day',yLabel:'Action score (1-5)'});
  graph('outcomes','Random roll outcomes','Original random outcomes when available; manual outcomes and actual wettings are excluded.','line',['Period','Pee','Hold'],days.map(d=>[d.label,d.pee,d.hold]));
  graph('probability','Saved roll probability','Mean recorded probability (%) at draw time. Empty periods are omitted.','line',['Period','Probability (%)'],days.filter(d=>d.probabilityN).map(d=>[d.label,d.probability/d.probabilityN]));
  graph('calibration','Draw calibration','Observed pee-draw percentage beside the saved chance. Small samples are noisy; these are draws, not actual wetting rates.','line',['Saved chance (%)','Observed pee (%)','Expected (%)','Draw count'],[...calibration].sort((a,b)=>a[0]-b[0]).map(([p,c])=>[String(p),100*c.pee/c.n,p,c.n]));
  graphs.at(-1).plotColumns=[1,2];
  graph('desperation','Desperation at roll time','Reported levels for independent rolls. Older rolls without a level appear as Not recorded; desperation does not change the calculated chance.','bar',['Desperation','Rolls'],[...desperationCounts].map(([level,count])=>[DESPERATION_LABELS[level]??'Not recorded',count]));
  graph('position','Wetting positions','Position counts for classified wettings only.','bar',['Position','Events'],[...positions]);
  graph('hour','Wetting by local hour','Hour from each event\'s recorded offset, not the administrator\'s timezone.','bar',['Hour','Events'],hours.map((n,h)=>[String(h).padStart(2,'0')+':00',n]));
  graph('weekday','Wetting by weekday','Recorded local calendar day; totals are not normalized for days of observation.','bar',['Weekday','Events'],weekdays.map((n,i)=>[['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],n]));
  graph('diapers','Highest diaper number per day','Mean of the highest reported diaper number for each participant-day. This is not a count of diaper changes.','line',['Period','Mean highest number'],days.filter(d=>d.diaperN).map(d=>[d.label,d.diapers/d.diaperN]));
  graph('reported','Historical reported wettings per diaper','Legacy snapshot totals only: mean maximum cumulative count per participant/day/diaper. New diaper-change records appear separately.','line',['Period','Mean reported count'],days.filter(d=>d.reportedN).map(d=>[d.label,d.reportedWettings/d.reportedN]));
  graph('changes','Recorded diaper changes','One count per saved change, grouped by its recorded local date. Legacy diaper numbers do not imply a change.','bar',['Period','Changes'],days.map(d=>[d.label,d.changes]));
  graph('completed-diapers','Wettings before a diaper change','Mean final count per changed diaper, including dry changes. These totals do not add classified wetting events.','line',['Period','Wettings per changed diaper'],days.filter(d=>d.changes).map(d=>[d.label,d.changedWettings/d.changes]));
  graph('association','Intake and classified events','One point per participant-day with an observation. Association does not establish causation; missing observations are excluded.','scatter',['Participant / day','Logged mL','Classified events'],scatter);
  graph('participants','Activity by participant','Counts within the selected dates. Users remain separate even when names match.','bar',['Participant','Observations','Wettings','Random rolls'],summaries.map(u=>[u.label+' / '+u.id.slice(0,8),u.observations,u.wettings,u.rolls]));
  graph('types','Record types','Includes enrollment records and legacy snapshots for auditing.','bar',['Type','Records'],[...kinds]);
  graph('provenance','Outcome provenance','Random versus manual outcomes from independent draws and legacy snapshots.','bar',['Source','Outcomes'],[...sources]);
  graph('corrections','Edited records','Only record types carrying an edited flag are included.','bar',['Status','Records'],[...edits]);
  graph('stars','Potty chart stars','Stars by calendar date from the current saved charts; deleted stars are not an immutable event history.','line',['Period','Stars'],[...chartDays].sort((a,b)=>a[0].localeCompare(b[0])));
  graph('row-stars','Stars by chart line','Current user-authored labels; different participants and row IDs are never merged. See line descriptions below.','bar',['Participant / line','Stars'],chartRows.map(row=>[row[0]+' / '+row[3]+' ['+row[2]+']',row[5]]));
  graph('current-chance','Current protocol chance','Current probability computed from each user\'s complete enrollment history; date filters do not alter this snapshot.','bar',['Participant','Chance (%)'],summaries.filter(u=>u.probability!==null).map(u=>[u.label+' / '+u.id.slice(0,8),u.probability]));
  graph('refusals','Current chart refusal counts','Lifetime counters in the current chart, with no event timestamps; unaffected by date filters.','bar',['Participant','Refusals'],summaries.filter(u=>u.refusals!==null).map(u=>[u.label+' / '+u.id.slice(0,8),u.refusals]));
  graph('reveal','Current chart reveal status','Current saved state, not a dated transition. Users without charts are excluded.','bar',['Status','Charts'],[['Revealed',summaries.filter(u=>u.revealed===true).length],['Not revealed',summaries.filter(u=>u.revealed===false).length]]);
  return {graphs,records,chartRows,summaries,totals:{users:dataset.users.length,observations,wettings,randomRolls,changes,liquids:totalLiquids,stars,averageProbability:probabilityCount?probabilitySum/probabilityCount:null}};
}
