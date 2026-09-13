import { sortedEntries } from './model.js';

function currentDiaper(entries) { // The latest actual change starts a new diaper; a calendar boundary does not.
  const ordered=sortedEntries(entries);
  const index=ordered.findIndex(entry=>entry.kind==='diaper-change');
  const active=index<0?ordered:ordered.slice(0,index);
  return Math.min(10000,active.reduce((number,entry)=>Math.max(number,entry.diaperNumber??0),(index<0?0:ordered[index].diaperNumber)+1));
}

export function diaperSummary(entries, day) { // Daily totals count completed changes, while the active diaper carries across dates.
  const changes=entries.filter(entry=>entry.kind==='diaper-change'&&entry.occurredAt.slice(0,10)===day);
  return {changes:changes.length,wettings:changes.reduce((sum,entry)=>sum+entry.wettingsCount,0),
    currentDiaper:currentDiaper(entries.filter(entry=>entry.occurredAt.slice(0,10)<=day))};
}

export function diaperAtTime(entries, occurredAt) { // Later changes cannot shift a backdated event, including across midnight.
  return currentDiaper(entries.filter(entry=>Date.parse(entry.occurredAt)<=Date.parse(occurredAt)));
}

export function suggestedDiaperWettings(entries, day, diaperNumber, before) { // Count the active diaper's whole wear period, including overnight wettings.
  const known=entries.filter(entry=>before?Date.parse(entry.occurredAt)<=Date.parse(before):entry.occurredAt.slice(0,10)<=day);
  const ordered=sortedEntries(known),index=ordered.findIndex(entry=>entry.kind==='diaper-change');
  const period=index<0?ordered:ordered.slice(0,index); // Stable insertion order distinguishes a change and a later wetting saved in the same second.
  const active=diaperNumber===currentDiaper(known);
  const relevant=period.filter(entry=>entry.diaperNumber===diaperNumber||(active&&entry.kind==='wetting')); // Include old overnight records whose numbers were reset by earlier app versions.
  const historical=relevant.findIndex(entry=>entry.wettingsCount!==undefined);
  const baseline=historical<0?0:relevant[historical].wettingsCount;
  const later=historical<0?relevant:relevant.slice(0,historical);
  return Math.min(10000,baseline+later.filter(entry=>entry.kind==='wetting').length);
}
