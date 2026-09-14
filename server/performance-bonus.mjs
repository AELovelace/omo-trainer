// Server-only reward policy. Scientific inputs never travel to the market database or public app assets.
export function performanceBonus(entry) {
  if(entry?.kind==='observation')return 5;
  if(entry?.kind==='wetting')return ({forced:5,'semi-forced':10,voluntary:15,'semi-involuntary':20,involuntary:25})[entry.category]??0;
  if(entry?.kind==='diaper-change')return Number.isInteger(entry.wettingsCount)&&entry.wettingsCount>=0&&entry.wettingsCount<=10000?5*(1+entry.wettingsCount):0; // One base award plus one base-sized increment per recorded wetting.
  if(entry?.kind==='roll'&&['hold','pee'].includes(entry.result))return (entry.result==='pee'?10:5)+(({low:0,medium:2,high:4,crisis:6})[entry.desperation]??0);
  return 0; // Legacy snapshots and protocol records do not generate currency.
}
