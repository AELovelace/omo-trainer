import { sortedEntries } from './model.js';

export function diaperSummary(entries, day) { // Daily change totals come from actual change events, never from a diaper number or a wetting snapshot.
  const sameDay=entries.filter(entry=>entry.occurredAt.slice(0,10)===day);
  const changes=sameDay.filter(entry=>entry.kind==='diaper-change');
  return {changes:changes.length,wettings:changes.reduce((sum,entry)=>sum+entry.wettingsCount,0),
    currentDiaper:Math.min(10000,sameDay.reduce((max,entry)=>Math.max(max,(entry.diaperNumber??0)+(entry.kind==='diaper-change'?1:0)),1))};
}

export function suggestedDiaperWettings(entries, day, diaperNumber, before) { // Suggest recorded totals for the selected day/diaper; the user can include unlogged or overnight wettings.
  const relevant=sortedEntries(entries.filter(entry=>entry.kind!=='diaper-change' && entry.diaperNumber===diaperNumber &&
    entry.occurredAt.slice(0,10)===day && (!before || Date.parse(entry.occurredAt)<=Date.parse(before))));
  const historical=relevant.findIndex(entry=>entry.wettingsCount!==undefined);
  const baseline=historical<0?0:relevant[historical].wettingsCount;
  const later=historical<0?relevant:relevant.slice(0,historical);
  return Math.min(10000,baseline+later.filter(entry=>entry.kind==='wetting').length);
}
