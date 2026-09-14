const $=selector=>document.querySelector(selector);
let data=null,anchor='',selected='',controller=null,epoch=0;
const visible=()=>location.hash==='#login-bonuses';
const date=day=>new Date(day+'T12:00:00Z');
const key=value=>value.toISOString().slice(0,10);
const shift=(day,count)=>key(new Date(Number(date(day))+count*86400000)); // Calendar movement uses whole calendar dates, independently of the device timezone.
const reward=value=>value?`${value.amount} ${value.asset==='coins'?'coins':value.amount===1?'diamond':'diamonds'}`:'No reward';
function range() { // Both views start on Monday; monthly padding never exceeds six weeks.
  const weekly=$('#bonus-view').value==='week',first=weekly?anchor:anchor.slice(0,7)+'-01';
  const start=shift(first,-((date(first).getUTCDay()+6)%7));
  const last=weekly?shift(start,6):key(new Date(Date.UTC(date(anchor).getUTCFullYear(),date(anchor).getUTCMonth()+1,0,12)));
  return {from:start,to:weekly?last:shift(last,6-((date(last).getUTCDay()+6)%7))};
}
function element(tag,text,className) {const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;} // Treat every server value as text, never HTML.
function details(day) {
  selected=day.day;
  $('#bonus-day-title').textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeZone:'UTC'}).format(date(day.day));
  $('#bonus-day-reward').textContent=day.checkin?`Day ${day.checkin.streak} in a row: ${reward(day.checkin)}${day.checkin.paid?' paid.':' pending delivery.'}`:day.day>data.today?'Upcoming day.':'No check-in bonus recorded for this day.';
  const stats=$('#bonus-day-stats');stats.replaceChildren();
  for(const [label,value] of [['Observations',day.observations],['Recorded events',day.wettings],['Diaper changes',day.changes],['Wettings in changed diapers',day.changedWettings],['Intake (mL)',day.liquidsMl],['Rolls',day.rolls],...Object.entries(day.categories).map(([label,value])=>[label.replaceAll('-',' '),value])]) {
    const item=element('div','');item.append(element('dt',label),element('dd',String(value)));stats.append(item);
  }
  for(const button of $('#bonus-calendar').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.day===selected));
}
function render() { // Show immutable bonus receipts beside current statistics, which can reflect later record corrections.
  $('#bonus-content').hidden=false;
  $('#bonus-month').value=anchor.slice(0,7);
  $('#bonus-streak').textContent=String(data.streak);$('#bonus-best').textContent=String(data.longestStreak);$('#bonus-total').textContent=String(data.totalDays);
  $('#bonus-next').textContent=reward(data.nextReward);
  $('#bonus-status').textContent=(data.checkedInToday?'Today is checked in!':'Save and sync an observation, wetting or diaper change to check in today.')+` Days use ${data.timeZone}.`;
  $('#bonus-range').textContent=$('#bonus-view').value==='week'?`${data.from} to ${data.to}`:new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric',timeZone:'UTC'}).format(date(anchor));
  const grid=$('#bonus-calendar');grid.replaceChildren();
  for(const label of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])grid.append(element('span',label,'bonus-weekday'));
  for(const day of data.days) {
    const button=element('button','','bonus-day'+(day.checkin?' checked':'')+(day.day===data.today?' today':'')+(day.day.slice(0,7)!==anchor.slice(0,7)?' outside':''));button.type='button';button.dataset.day=day.day;
    if(day.day===data.today)button.setAttribute('aria-current','date');
    const payout=day.checkin?reward(day.checkin):day.day>data.today?'Upcoming':'No bonus';
    button.setAttribute('aria-label',`${day.day}: ${payout}; ${day.observations} observations, ${day.wettings} events, ${day.changes} changes. Show daily statistics.`);
    const compact=day.checkin?`${day.checkin.amount}${day.checkin.asset==='coins'?'c':' 💎'}`:'—';
    button.append(element('strong',String(Number(day.day.slice(-2)))),element('span',payout,'bonus-payout'),element('span',compact,'bonus-payout-short'),element('small',day.checkin?`#${day.checkin.streak}${day.checkin.paid?'':' pending'}`:''),element('small',day.observations+day.wettings+day.changes?`${day.observations} obs · ${day.wettings} events · ${day.changes} changes`:'','bonus-cell-stats')); // Compact phone cells keep the full reward and statistics in the accessible name and selected-day details.
    button.addEventListener('click',()=>details(day));grid.append(button);
  }
  details(data.days.find(day=>day.day===selected)??data.days.find(day=>day.day===data.today)??data.days[0]);
}
async function refresh(reset=false) { // Cancel stale range/account requests so navigation never displays another account's calendar.
  if(!visible())return;
  controller?.abort();controller=new AbortController();const signal=controller.signal,current=++epoch;
  $('#bonus-status').textContent='Loading your login bonuses...';
  try {
    async function read(query='') {
      const response=await fetch('./api/login-bonuses'+query,{credentials:'same-origin',cache:'no-store',signal});const value=await response.json();
      if(!response.ok)throw Error(response.status===401?'Sign in and connect your device in Settings to earn login bonuses.':value.error||'Could not load your calendar.');return value;
    }
    if(!anchor||reset){const overview=await read();anchor=overview.today;selected=anchor;}
    const {from,to}=range(),result=await read('?'+new URLSearchParams({from,to}));
    if(current!==epoch)return;data=result;render();
  } catch(error) {if(signal.aborted||current!==epoch)return;data=null;$('#bonus-content').hidden=true;$('#bonus-status').textContent=error.message||'Reconnect to load your calendar.';}
}
$('#bonus-view').addEventListener('change',()=>refresh());
$('#bonus-month').addEventListener('change',event=>{if(/^\d{4}-\d{2}$/.test(event.target.value)){anchor=event.target.value+'-01';selected=anchor;void refresh();}});
for(const [id,step] of [['bonus-prev',-1],['bonus-next-period',1]])$('#'+id).addEventListener('click',()=>{
  if(!anchor)return;anchor=$('#bonus-view').value==='week'?shift(anchor,step*7):key(new Date(Date.UTC(date(anchor).getUTCFullYear(),date(anchor).getUTCMonth()+step,1,12)));selected=anchor;void refresh();
});
$('#bonus-today').addEventListener('click',()=>refresh(true));$('#bonus-refresh').addEventListener('click',()=>refresh());
window.addEventListener('hashchange',()=>{if(visible())void refresh();else{controller?.abort();epoch++;}});
for(const event of ['online','focus','little-log-rewards-updated'])window.addEventListener(event,()=>refresh());
window.addEventListener('little-log-signout',()=>{controller?.abort();epoch++;data=null;anchor='';selected='';$('#bonus-content').hidden=true;$('#bonus-calendar').replaceChildren();$('#bonus-day-stats').replaceChildren();$('#bonus-status').textContent='Sign in to view your login bonuses.';});
setInterval(()=>{if(visible()&&!document.hidden)void refresh();},60000); // An open calendar notices midnight and rewards synced by another device.
if(visible())void refresh();
