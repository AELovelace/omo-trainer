import {trainPredictor,forecastPotty} from './prediction.js';
let cachedEntries,cachedAccount,cachedDay,model,lastMinute=-1;
const $=id=>document.getElementById(id);
const duration=minutes=>`${Math.round(minutes)} min`;
const clock=(now,minutes)=>minutes===null?'beyond 8 hours':new Date(now+minutes*60000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
export function renderPrediction(entries,account='local',force=false,now=Date.now()) { // Cache training by account and record array; minute ticks update only the conditional forecast.
  const day=Math.floor(now/86400000),minute=Math.floor(now/60000);
  const changed=cachedEntries!==entries||cachedAccount!==account||cachedDay!==day||now>=model?.nextFuture;
  if(!changed&&!force&&lastMinute===minute)return;
  if(changed||!model){model=trainPredictor(entries,now);cachedEntries=entries;cachedAccount=account;cachedDay=day;}
  lastMinute=minute;const forecast=forecastPotty(model,now),ready=forecast.status==='ready';
  $('prediction-evidence').textContent=ready?`${model.evidence} evidence`:forecast.status==='stale'?'Estimate paused':'Learning your pattern';
  $('prediction-result').hidden=!ready;$('prediction-plot').hidden=!ready;$('prediction-table-wrap').hidden=!ready;
  $('prediction-status').textContent=forecast.status==='learning'
    ?`Keep recording actual wettings. Your model needs at least 8 usable intervals across 3 days; it currently has ${model.n} across ${model.days} days.`
    :forecast.status==='stale'?'Your last wetting record is over 8 hours old. The estimate is paused until you record another event.':`Based on your records, with no additional drinks assumed. Updated ${new Date(now).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}. Times may cross midnight.`;
  $('prediction-interval').textContent=model.n?`${duration(model.meanMinutes)} average · ${duration(model.medianMinutes)} median`:'Not enough records yet';
  $('prediction-intake').textContent=`${Math.round(model.intakeReports.filter(report=>report.time>=now-360*60000).reduce((sum,report)=>sum+report.ml,0))} mL logged in the last 6 hours`;
  $('prediction-model').textContent=model.kind==='timing-and-drinks'?`Timing + drinks · ${model.halfLife}-minute fluid-response half-life proxy`:model.kind==='learning'?'Collecting history':'Personal wetting intervals; drink adjustment has not yet improved validation';
  $('prediction-detail').textContent=`Uses ${model.n} intervals over ${model.days} recorded days, from the last 90 days (at most 360 intervals). ${model.excluded} gaps shorter than 5 minutes or longer than 8 hours excluded. ${model.uncertainDrinks} intake reports have uncertain timing and are excluded from the fluid model. All wetting classifications count, so planned or forced events also affect your pattern. Rolls and diaper-change totals do not count as wettings.`;
  $('prediction-validation').textContent=model.validation?`Chronological validation: ${model.validation.intervals} held-out intervals. Next-15-minute Brier score ${model.validation.brier.toFixed(3)}; timing-only ${model.validation.baselineBrier.toFixed(3)} (lower is better). Fluid adjustment requires at least a 5% improvement. This is development validation, not clinical validation.`:'Drink-response learning starts after 30 intervals across 7 days, with at least 20 timed intake reports and varied amounts. Until then the model uses your intervals.';
  if(!ready){$('prediction-bars').replaceChildren();$('prediction-data').replaceChildren();return;}
  $('prediction-window').textContent=`${clock(now,forecast.fromMinutes)} – ${clock(now,forecast.toMinutes)}`;
  $('prediction-likely').textContent=`Most likely 15-minute window: ${clock(now,forecast.peak.from)} – ${clock(now,forecast.peak.to)}. Estimated chance within an hour: ${Math.round(100*forecast.nextHour)}%.`;
  const bars=$('prediction-bars'),body=$('prediction-data');bars.replaceChildren();body.replaceChildren();
  const groups=Array.from({length:12},(_,i)=>({from:i*30,to:(i+1)*30,probability:forecast.bins[2*i].probability+forecast.bins[2*i+1].probability}));
  const max=Math.max(...groups.map(g=>g.probability),0.01),ns='http://www.w3.org/2000/svg';
  for(const group of groups){ // The visible plot and accessible table share the same unconditional event-bin probabilities.
    const rect=document.createElementNS(ns,'rect'),height=110*group.probability/max;rect.setAttribute('x',String(group.from/30*40+4));rect.setAttribute('y',String(120-height));rect.setAttribute('width','30');rect.setAttribute('height',String(height));rect.setAttribute('rx','3');
    const title=document.createElementNS(ns,'title');title.textContent=`${group.from}–${group.to} minutes: ${(group.probability*100).toFixed(1)}%`;rect.append(title);bars.append(rect);
    const row=document.createElement('tr');for(const text of [`${group.from}–${group.to} min`,`${(group.probability*100).toFixed(1)}%`]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}body.append(row);
  }
  $('prediction-scale').textContent=`Each bar: 30 minutes · tallest bar: ${(max*100).toFixed(1)}%`;
}
