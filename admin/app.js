import { renderPrediction, clearPrediction } from '../lib/prediction-view.js?admin=1'; // Bypass older PWA shell caches for the admin renderer.
import { analyzeDataset } from '../lib/admin-analytics.js';
import { datasetCsv } from '../lib/admin-format.js';

const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); // Escape user-authored labels before creating HTML or SVG.
const colors=['#ff96c8','#b3a4f4','#ffe66f','#7fd9c7','#88bfff']; // Five distinct keys cover every action category.
const fmt=value=>typeof value==='number'?Number(value.toFixed(2)).toLocaleString():String(value??'');
let csrf='',actor=null,users=[],dataset=null,analysis=null,preview=null,recordLimit=100,loading=false,accessEpoch=0;
const pottyGraphIds=new Set(['stars','row-stars','refusals','reveal']);
let predictionRequest=0,predictionUser='',predictionEntries=null,predictionBusy=false;
let chartUserId='',chartWeek='',chartRequest=0,chartRefreshing=false;
const noticeEditors=[createNoticeEditor('reminder','Reminder'),createNoticeEditor('margin-note','Margin note')];
const chartUpdates=typeof BroadcastChannel==='function'?new BroadcastChannel('little-log-chart-updates'):null; // Keep drilldown state only in memory alongside the authorized dataset.
const selectedId=()=>$('#participant-filter').value;
const cohort=()=>({...dataset,users:dataset.users.filter(user=>!selectedId() || user.id===selectedId())});

function clearPrivateView() { // Drop all in-memory cohort data and rendered records when authorization ends; never persist administrator datasets in browser storage.
  resetPrediction();
  for(const editor of noticeEditors)editor.clear();
  accessEpoch++; chartRequest++; $('#potty-detail').removeAttribute('aria-busy'); chartUserId=''; chartWeek=''; $('#potty-detail').hidden=true; $('#potty-detail-title').textContent='Participant chart'; csrf=''; actor=null; users=[]; dataset=null; analysis=null; preview=null;
  for(const selector of ['#potty-graphs','#potty-summary','#potty-users','#potty-detail-content','#graphs','#user-table','#chart-lines','#participant-snapshots','#record-table','#audit-table','#admin-summary','#import-preview']) $(selector).replaceChildren();
  $('#participant-filter').innerHTML='<option value="">Everyone</option>';
  $('#admin-workspace').hidden=true; $('#admin-gate').hidden=false; $('#refresh').hidden=true; $('#admin-identity').textContent='';
}
function status(message) { $('#admin-status').textContent=message; }
async function request(route,payload) { // Same-origin HttpOnly sessions and CSRF protect every privileged operation; responses are never cached.
  const epoch=accessEpoch;
  const response=await fetch('../api/admin/'+route,{credentials:'same-origin',cache:'no-store',redirect:'error',
    ...(payload===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(payload)})});
  const result=await response.json();
  if(epoch!==accessEpoch) throw Error('Administrator session changed. Refresh to continue.');
  if(!response.ok) {
    if(response.status===401 || response.status===403) clearPrivateView();
    throw Error(result.error || 'The request failed.');
  }
  return result;
}
function download(name,text,type) { // Generate a local download only after server-authorized retrieval.
  const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');
  link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function table(columns,rows) { // Exact values remain available alongside every graph, including empty and small cohorts.
  return '<table><thead><tr>'+columns.map(value=>'<th scope="col">'+escape(value)+'</th>').join('')+'</tr></thead><tbody>'+
    (rows.length?rows.map(row=>'<tr>'+row.map(value=>'<td>'+escape(fmt(value))+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+columns.length+'">No matching records.</td></tr>')+'</tbody></table>';
}
function plot(graph) { // Dependency-free SVG plots use explicit axes and tooltips, with complete values in the accompanying table.
  let rows=graph.rows;
  if(!rows.length) return '<p class="plot-empty">No matching data for this graph.</p>';
  const limit=graph.type==='bar'?40:graph.type==='scatter'?600:400;
  if(rows.length>limit) rows=graph.type==='line'?rows.slice(-limit):rows.slice(0,limit);
  const cols=graph.plotColumns ?? graph.columns.slice(1).map((_,i)=>i+1);
  const w=720,h=300,left=58,right=16,top=16,bottom=62,pw=w-left-right,ph=h-top-bottom;
  const max=Math.max(1,...rows.flatMap(row=>(graph.type==='scatter'?[row[2]]:cols.map(i=>row[i])).map(Number)));
  const maxX=Math.max(1,...rows.map(row=>graph.type==='scatter'?Number(row[1]):0));
  const [yMin,yMax]=graph.yDomain??[0,max];
  const y=value=>top+ph-((Number(value)-yMin)/(yMax-yMin))*ph;
  let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+escape(graph.title)+'"><title>'+escape(graph.title)+'</title><rect width="'+w+'" height="'+h+'" fill="#260b20"/>';
  for(let i=0;i<=4;i++) {
    const value=yMin+(yMax-yMin)*i/4,py=y(value);
    svg+='<path d="M'+left+' '+py+'H'+(w-right)+'" stroke="#5f344e"/><text x="'+(left-8)+'" y="'+(py+4)+'" text-anchor="end" fill="#cca9bd" font-size="11">'+escape(fmt(value))+'</text>';
  }
  if(graph.type==='scatter') {
    for(const row of rows) svg+='<circle cx="'+(left+Number(row[1])/maxX*pw)+'" cy="'+y(row[2])+'" r="4" fill="#ff96c8" opacity=".65"><title>'+escape(row[0]+': '+fmt(row[1])+' mL, '+fmt(row[2])+' events')+'</title></circle>';
    svg+='<text x="'+left+'" y="'+(h-34)+'" fill="#cca9bd" font-size="11">0</text><text x="'+(w-right)+'" y="'+(h-34)+'" text-anchor="end" fill="#cca9bd" font-size="11">'+escape(fmt(maxX))+'</text><text x="'+(w/2)+'" y="'+(h-10)+'" text-anchor="middle" fill="#cca9bd" font-size="12">Logged intake (mL)</text>';
  } else {
    const step=pw/Math.max(1,rows.length),dates=graph.dateAxis?rows.map(row=>Date.parse(row[0]+'T00:00:00Z')):null;
    const x=i=>dates?(dates.at(-1)===dates[0]?left+pw/2:left+8+(dates[i]-dates[0])/(dates.at(-1)-dates[0])*(pw-16)):left+step*(i+.5); // Calendar spacing keeps gaps proportional to elapsed days.
    for(const [series,col] of cols.entries()) {
      const color=colors[series%colors.length];
      if(graph.type==='line') {
        const segments=[[]];
        rows.forEach((row,i)=>{if(graph.breakOnDayGap&&i&&dates[i]-dates[i-1]>86400000)segments.push([]);segments.at(-1).push(x(i)+','+y(row[col]));});
        svg+=segments.filter(points=>points.length>1).map(points=>'<polyline fill="none" stroke="'+color+'" stroke-width="2" points="'+points.join(' ')+'"/>').join(''); // No trend is drawn through a day with no recorded events.
        svg+=rows.map((row,i)=>'<circle cx="'+x(i)+'" cy="'+y(row[col])+'" r="3" fill="'+color+'"><title>'+escape(row[0]+' / '+graph.columns[col]+': '+fmt(row[col]))+'</title></circle>').join('');
      } else {
        const bw=step*.76/cols.length;
        svg+=rows.map((row,i)=>'<rect x="'+(left+i*step+step*.12+series*bw)+'" y="'+y(row[col])+'" width="'+Math.max(.1,bw-1)+'" height="'+Math.max(0,top+ph-y(row[col]))+'" fill="'+color+'"><title>'+escape(row[0]+' / '+graph.columns[col]+': '+fmt(row[col]))+'</title></rect>').join('');
      }
    }
    const stride=Math.max(1,Math.ceil(rows.length/7));
    rows.forEach((row,i)=>{if(i%stride===0) svg+='<text x="'+x(i)+'" y="'+(h-34)+'" text-anchor="middle" fill="#cca9bd" font-size="10">'+escape(String(row[0]).slice(0,18))+'</text>';});
  }
  if(graph.xLabel)svg+='<text x="'+(left+pw/2)+'" y="'+(h-8)+'" text-anchor="middle" fill="#cca9bd" font-size="12">'+escape(graph.xLabel)+'</text>';
  if(graph.yLabel)svg+='<text transform="translate(13 '+(top+ph/2)+') rotate(-90)" text-anchor="middle" fill="#cca9bd" font-size="11">'+escape(graph.yLabel)+'</text>';
  svg+='</svg>';
  if(graph.rows.length>limit) svg+='<p>Plot shows '+(graph.type==='line'?'the latest ':'the first ')+limit+' rows. Exact data and exports include all '+graph.rows.length+' rows.</p>';
  return svg;
}
function renderAnalytics() { // Date and participant filters recompute charts locally without changing or uploading records.
  if(!dataset) return;
  const from=$('#date-from').value,to=$('#date-to').value;
  if(from && to && from>to) { status('Analysis start must be on or before its end.'); return; }
  analysis=analyzeDataset(cohort(),{from,to,interval:$('#interval').value,timeBinHours:Number($('#action-time-bin').value)});
  const t=analysis.totals;
  $('#admin-summary').innerHTML=[['Participants',t.users],['Observations',t.observations],['Classified wettings',t.wettings],['Diaper changes',t.changes],['Random rolls',t.randomRolls],['Logged intake (mL)',t.liquids],['Chart stars',t.stars]].map(([label,n])=>'<article><strong>'+escape(fmt(n))+'</strong><span>'+label+'</span></article>').join('');
  const graphCard=graph=>{
    const cols=graph.plotColumns??graph.columns.slice(1).map((_,i)=>i+1);
    const labels=graph.type==='scatter'?['One point per participant-day (X: '+graph.columns[1]+'; Y: '+graph.columns[2]+')']:cols.map(i=>graph.columns[i]); // Describe every plotted color and explain both scatter axes.
    return '<article class="card admin-graph" id="graph-'+graph.id+'"><h3>'+escape(graph.title)+'</h3><p>'+escape(graph.description)+'</p>'+plot(graph)+
      '<div class="admin-legend" role="group" aria-label="Chart legend">'+labels.map((label,n)=>'<span><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" fill="'+colors[n%colors.length]+'"/></svg><span class="admin-legend-label">'+escape(label)+'</span></span>').join('')+'</div>'+
      '<details><summary>Exact data ('+graph.rows.length+' rows)</summary><div class="table-scroll">'+table(graph.columns,graph.rows)+'</div></details><div class="admin-buttons"><button class="button secondary small" data-svg="'+graph.id+'">Download SVG</button><button class="button secondary small" data-graph-csv="'+graph.id+'">Data CSV</button></div></article>';
  };
  $('#graphs').innerHTML=analysis.graphs.filter(graph=>!pottyGraphIds.has(graph.id)).map(graphCard).join('');
  $('#potty-graphs').innerHTML=analysis.graphs.filter(graph=>pottyGraphIds.has(graph.id)).map(graphCard).join('');
  renderPottyCharts();
  $('#chart-lines').innerHTML=table(['Participant','Participant ID','Row ID','Label','Note','Stars','Status'],analysis.chartRows);
  $('#participant-snapshots').innerHTML=table(['Participant','ID','Enrolled','Timezone','Current chance (%)','Chart since','Chart saved','Refusals','Revealed'],analysis.summaries.map(u=>[u.label,u.id,u.enrolled,u.timezone,u.probability,u.chartSince,u.chartUpdated,u.refusals,u.revealed]));
  recordLimit=100; renderRecords();
}
function renderPottyCharts() { // Summarize only the selected cohort; distinguish absent charts from saved charts with zero stars.
  const selected=cohort().users, linked=selected.filter(user=>user.growthChart?.chart);
  const items=[['Linked charts',linked.length],['Without a saved chart',selected.length-linked.length],['Chart rows',linked.reduce((n,user)=>n+user.growthChart.chart.rows.length,0)],['Stars in selected dates',analysis.totals.stars]];
  $('#potty-summary').innerHTML=items.map(([label,n])=>'<article><strong>'+escape(fmt(n))+'</strong><span>'+label+'</span></article>').join('');
  $('#potty-users').innerHTML='<table><thead><tr><th>Participant</th><th>Chart name</th><th>Rows</th><th>Stars in selected dates</th><th>Last saved</th><th>Chart</th></tr></thead><tbody>'+selected.map(user=>{
    const chart=user.growthChart?.chart;
    return '<tr><td>'+escape(user.label)+'<br><small>'+escape(user.id)+'</small></td><td>'+escape(chart?.name??'No saved chart')+'</td><td>'+(chart?chart.rows.length:'—')+'</td><td>'+(chart?analysis.summaries.find(summary=>summary.id===user.id).stars:'—')+'</td><td>'+escape(user.growthChart?.updatedAt??'')+'</td><td><button class="button secondary small" data-chart-user="'+escape(user.id)+'">View chart</button></td></tr>';
  }).join('')+'</tbody></table>';
  if(!selected.some(user=>user.id===chartUserId)) { chartUserId=selected.length===1?selected[0].id:''; chartWeek=''; }
  renderPottyDetail();
}
function weekStart(day) { // Calendar navigation uses UTC date arithmetic so daylight-saving shifts cannot move a column.
  const value=new Date(day+'T12:00:00Z');
  value.setUTCDate(value.getUTCDate()-(value.getUTCDay()+6)%7);
  return value.toISOString().slice(0,10);
}
function shiftDay(day,offset) {
  const value=new Date(day+'T12:00:00Z'); value.setUTCDate(value.getUTCDate()+offset);
  return value.toISOString().slice(0,10);
}
function renderPottyDetail() { // Render a read-only chart from the authorized snapshot, preserving each row's ID, meaning and dated stars.
  const user=dataset?.users.find(user=>user.id===chartUserId);
  $('#potty-detail').hidden=!user;
  if(!user) { $('#potty-detail-content').replaceChildren(); return; }
  $('#potty-detail-title').textContent=user.label+'’s potty chart';
  const chart=user.growthChart?.chart;
  if(!chart) { $('#potty-detail-content').textContent='This participant has no saved linked potty chart.'; return; }
  const stars=Object.keys(chart.stars).sort(),byRow=new Map(chart.rows.map(row=>[row.id,[]]));
  for(const key of stars) { const [day,rowId]=key.split(':'); byRow.get(rowId)?.push(day); }
  if(!chartWeek) chartWeek=weekStart(stars.at(-1)?.slice(0,10)??new Date().toISOString().slice(0,10));
  const dates=Array.from({length:7},(_,i)=>shiftDay(chartWeek,i));
  $('#potty-detail-content').innerHTML='<p class="section-copy">Saved chart from the Chrysalis file. Unsynced browser changes are not included; analysis date filters do not hide saved history. Stars use the current row labels. Empty cells mean no saved star.</p>'+
    '<div class="table-scroll">'+table(['Chart name','Participant ID','Started','Last saved','Saved version','Total stars','Refusals','Reveal status'],[[chart.name,user.id,chart.since,user.growthChart.updatedAt,user.growthChart.version,stars.length,chart.refusals,chart.escaped?'Revealed':'Not revealed']])+'</div>'+
    '<div class="admin-buttons potty-week"><button class="button secondary" data-chart-week="-7">Previous week</button><div><label for="potty-week-date">Week containing</label><input id="potty-week-date" type="date" value="'+chartWeek+'"></div><button class="button secondary" data-chart-week="7">Next week</button></div>'+
    '<div class="table-scroll"><table class="potty-grid"><caption>Week of '+chartWeek+'</caption><thead><tr><th scope="col">Chart line</th>'+dates.map(day=>'<th scope="col">'+day+'</th>').join('')+'<th scope="col">All stars</th></tr></thead><tbody>'+chart.rows.map(row=>'<tr><th scope="row" class="wrap">'+escape(row.label)+'</th>'+dates.map(day=>'<td>'+(chart.stars[day+':'+row.id]?'<span class="potty-star" role="img" aria-label="Star">&#9733;</span>':'<span aria-label="No saved star">&#8212;</span>')+'</td>').join('')+'<td>'+byRow.get(row.id).length+'</td></tr>').join('')+'</tbody></table></div>'+
    '<h3>Chart lines and full star history</h3><div class="potty-row-details">'+chart.rows.map(row=>'<details><summary>'+escape(row.label)+' ('+byRow.get(row.id).length+' stars)</summary><dl><dt>Row ID</dt><dd>'+escape(row.id)+'</dd><dt>Description</dt><dd>'+escape(row.note||'No description')+'</dd><dt>Praise</dt><dd>'+escape(row.praise||'No saved praise')+'</dd><dt>Status</dt><dd>'+(row.locked?'Locked':'Editable')+'</dd><dt>All saved star dates</dt><dd>'+escape(byRow.get(row.id).join(', ')||'No saved stars')+'</dd></dl></details>').join('')+'</div>';
}
async function loadPottyChart(id,focus=false) { // Re-fetch the selected participant rather than displaying the snapshot from when the admin page opened.
  if(!dataset) return;
  const sequence=++chartRequest,selection=selectedId();
  chartUserId=id;
  const user=dataset.users.find(value=>value.id===id); if(!user) return;
  $('#potty-detail').hidden=false; $('#potty-detail-title').textContent=user.label+'’s potty chart';
  $('#potty-detail-content').textContent='Fetching the latest saved chart...';
  $('#potty-detail').setAttribute('aria-busy','true');
  try {
    const latest=await request('data?participantId='+encodeURIComponent(id));
    if(sequence!==chartRequest || !dataset || chartUserId!==id || selection!==selectedId()) return; // Ignore stale responses after participant switches, refreshes or sign-out.
    const current=latest.users.find(value=>value.id===id);
    if(!current) throw Error('This participant is no longer available.');
    dataset.users=dataset.users.map(value=>value.id===id?current:value);
    renderAnalytics(); renderPottyDetail();
    status('Fetched the latest saved chart for '+current.label+'.');
  } catch(error) {
    if(sequence!==chartRequest || !dataset) return;
    $('#potty-detail-content').textContent='Could not fetch the latest chart. '+error.message;
    status(error.message);
  } finally {
    if(sequence===chartRequest) {
      $('#potty-detail').removeAttribute('aria-busy');
      if(focus && dataset) { $('#potty-detail-title').focus(); $('#potty-detail').scrollIntoView({block:'start'}); }
    }
  }
}
$('#potty-users').addEventListener('click',event=>{
  const button=event.target.closest('[data-chart-user]'); if(!button || !dataset) return;
  chartWeek=''; void loadPottyChart(button.dataset.chartUser,true);
});
$('#potty-detail-content').addEventListener('click',event=>{
  const button=event.target.closest('[data-chart-week]'); if(!button) return;
  const offset=Number(button.dataset.chartWeek),next=shiftDay(chartWeek,offset);
  if(!/^\d{4}-/.test(next)) return;
  chartWeek=next; renderPottyDetail();
  $('#potty-detail-content [data-chart-week="'+offset+'"]').focus();
});
$('#potty-detail-content').addEventListener('change',event=>{
  if(event.target.id!=='potty-week-date' || !event.target.value || !event.target.validity.valid) return;
  chartWeek=weekStart(event.target.value); renderPottyDetail(); $('#potty-week-date').focus();
});
function renderRecords() {
  if(!analysis) return;
  const kind=$('#record-kind').value,rows=analysis.records.filter(row=>!kind || (row.entry.kind??'legacy')===kind).sort((a,b)=>b.entry.occurredAt.localeCompare(a.entry.occurredAt));
  $('#record-count').textContent=rows.length+' records; showing '+Math.min(recordLimit,rows.length)+'.';
  $('#record-table').innerHTML='<table><thead><tr><th>Participant</th><th>Date & time</th><th>Type</th><th>Details</th></tr></thead><tbody>'+rows.slice(0,recordLimit).map(row=>'<tr><td>'+escape(row.participant)+'<br><small>'+escape(row.participantId)+'</small></td><td>'+escape(row.entry.occurredAt)+'</td><td>'+escape(row.entry.kind??'legacy')+'</td><td><details><summary>All recorded fields</summary><pre>'+escape(JSON.stringify(row.entry,null,2))+'</pre></details></td></tr>').join('')+'</tbody></table>';
  $('#more-records').hidden=rows.length<=recordLimit;
}
function renderUsers() { // User controls refer only to immutable participant IDs, including when usernames collide across issuers.
  const search=$('#user-search').value.trim().toLowerCase();
  const selected=users.filter(user=>(user.label+' '+user.id).toLowerCase().includes(search));
  $('#user-table').innerHTML='<table><thead><tr><th>User</th><th>Records / chart</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>'+selected.map(user=>'<tr data-user="'+escape(user.id)+'"><td>'+escape(user.label)+(user.id===actor?.id?' (you)':'')+'<br><small>'+escape(user.id)+'</small><details><summary>Verified identity</summary><p>'+escape(user.issuer)+'<br>'+escape(user.subject)+'</p></details></td><td>'+user.recordCount+' records<br>'+(user.hasChart?'Chart linked':'No chart')+'</td><td><select data-role aria-label="Role for '+escape(user.label)+'"><option value="participant"'+(user.role==='participant'?' selected':'')+'>Participant</option><option value="admin"'+(user.role==='admin'?' selected':'')+'>Admin</option></select></td><td><select data-disabled aria-label="Access for '+escape(user.label)+'"><option value="false"'+(!user.disabled?' selected':'')+'>Enabled</option><option value="true"'+(user.disabled?' selected':'')+'>Disabled</option></select></td><td><div class="admin-buttons"><button class="button primary small" data-save-user="'+escape(user.id)+'">Save access</button><button class="button secondary small" data-revoke="'+escape(user.id)+'">Revoke sessions</button><button class="button secondary small" data-inspect="'+escape(user.id)+'">View data</button><button class="button secondary small" data-prediction="'+escape(user.id)+'">Prediction</button></div></td></tr>').join('')+'</tbody></table>';
}
async function renderAudit() {
  const result=await request('audit');
  $('#audit-table').innerHTML=table(['When','Actor','Action','Target','Details'],result.audit.map(row=>[row.created_at,users.find(user=>user.id===row.actor_id)?.label??row.actor_id,row.action,row.target_id,row.details_json]));
}
function navigate() {
  const route=['analytics','potty-charts','predictions','users','transfer','reminders','audit'].includes(location.hash.slice(1))?location.hash.slice(1):'analytics';
  document.querySelectorAll('[data-panel]').forEach(panel=>panel.hidden=panel.dataset.panel!==route);
  document.querySelectorAll('[data-tab]').forEach(link=>{ if(link.dataset.tab===route) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
  $('.admin-filters').hidden=route==='reminders';
  if(route==='reminders'&&actor)for(const editor of noticeEditors)editor.loadInitial();
  if(route==='predictions') void loadPrediction(); else resetPrediction();
  if(route==='potty-charts') void refreshCharts();
  if(route==='audit' && actor) void renderAudit().catch(error=>status(error.message));
}
async function refreshCharts() { // Refresh visible chart statistics in the background without disturbing import previews or observation records.
  if(!actor || loading || chartRefreshing || location.hash!=='#potty-charts' || $('#potty-detail').getAttribute('aria-busy')==='true') return;
  const epoch=accessEpoch,sequence=chartRequest;
  chartRefreshing=true;
  try {
    const latest=await request('charts');
    if(!dataset || epoch!==accessEpoch || sequence!==chartRequest || loading || document.activeElement?.id==='potty-week-date') return;
    const saved=new Map(latest.users.map(user=>[user.id,user.growthChart]));
    let changed=false;
    dataset.users=dataset.users.map(user=>{
      const next=saved.get(user.id);
      if(!next || JSON.stringify(next)===JSON.stringify(user.growthChart)) return user;
      changed=true; return {...user,growthChart:next};
    });
    if(changed) {
      const open=[...document.querySelectorAll('.potty-row-details details')].map(node=>node.open);
      const scrolls=[...document.querySelectorAll('#potty-detail .table-scroll')].map(node=>[node.scrollLeft,node.scrollTop]);
      const focused=document.activeElement,weekControl=focused?.dataset.chartWeek;
      renderAnalytics();
      document.querySelectorAll('.potty-row-details details').forEach((node,i)=>{node.open=Boolean(open[i]);});
      document.querySelectorAll('#potty-detail .table-scroll').forEach((node,i)=>{if(scrolls[i]){node.scrollLeft=scrolls[i][0];node.scrollTop=scrolls[i][1];}});
      if(weekControl) $('#potty-detail [data-chart-week="'+weekControl+'"]').focus({preventScroll:true});
      status('Potty charts updated automatically.');
    }
  } catch(error) { if(dataset) status('Automatic chart refresh will retry. '+error.message); }
  finally { chartRefreshing=false; }
}
if(chartUpdates) chartUpdates.onmessage=()=>void refreshCharts();
window.addEventListener('focus',()=>void refreshCharts());
setInterval(()=>{if(!document.hidden)void refreshCharts();},15000);
function resetPreview() { preview=null; $('#import-preview').textContent=''; $('#apply-import').hidden=true; }
async function refresh() { // Fetch shared records only after a successful server-side admin check.
  if(loading) return;
  chartRequest++; $('#potty-detail').removeAttribute('aria-busy');
  loading=true; status('Loading administrator data…'); resetPreview();
  try {
    const session=await request('users'); csrf=session.csrf; actor=session.participant; users=session.users;
    const selected=selectedId();
    dataset=await request('data');
    $('#participant-filter').innerHTML='<option value="">Everyone</option>'+users.map(user=>'<option value="'+escape(user.id)+'">'+escape(user.label+' / '+user.id.slice(0,8))+'</option>').join('');
    if(users.some(user=>user.id===selected)) $('#participant-filter').value=selected;
    $('#admin-identity').textContent='Administrator: '+actor.label;
    $('#admin-workspace').hidden=false; $('#admin-gate').hidden=true; $('#refresh').hidden=false;
    renderUsers(); renderAnalytics(); navigate();
    status('Loaded '+users.length+' participants. Last refreshed '+new Date().toLocaleTimeString()+'.');
  } catch(error) { if(!actor) $('#admin-gate').hidden=false; status(error.message); }
  finally { loading=false; }
}
async function importInput() {
  const file=$('#import-file').files[0];
  if(!file) throw Error('Choose a CSV or JSON file.');
  if(file.size>16*1024*1024) throw Error('The file exceeds 16 MiB. Export/import individual participants or smaller batches.');
  const format=file.name.toLowerCase().endsWith('.csv')?'csv':'json';
  return {text:await file.text(),format,participantId:selectedId(),mode:$('#import-mode').value};
}
$('#preview-import').addEventListener('click',async()=>{
  resetPreview(); $('#preview-import').disabled=true;
  try {
    const input=await importInput(),result=await request('import-preview',input);
    preview={...input,token:result.token};
    $('#import-preview').textContent=Object.entries(result.summary).map(([key,value])=>key+': '+value).join(' · ');
    $('#apply-import').hidden=Boolean(result.summary.conflicts);
    if(result.summary.conflicts) $('#import-preview').textContent+=' — No data will be applied until conflicts are resolved.';
  } catch(error) { status(error.message); } finally { $('#preview-import').disabled=false; }
});
$('#apply-import').addEventListener('click',async()=>{
  if(!preview) return; $('#apply-import').disabled=true;
  try { const result=await request('import',preview); await refresh(); status('Import complete: '+JSON.stringify(result)); }
  catch(error) { resetPreview(); status(error.message); }
  finally { $('#apply-import').disabled=false; }
});
for(const selector of ['#import-file','#import-mode']) $(selector).addEventListener('change',resetPreview);
$('#participant-filter').addEventListener('change',()=>{
  resetPrediction();if(location.hash==='#predictions')void loadPrediction();
  chartRequest++; $('#potty-detail').removeAttribute('aria-busy'); resetPreview(); renderAnalytics();
  if(selectedId() && location.hash==='#potty-charts') void loadPottyChart(selectedId());
});
for(const selector of ['#date-from','#date-to','#interval','#action-time-bin']) $(selector).addEventListener('change',renderAnalytics);
$('#all-dates').addEventListener('click',()=>{$('#date-from').value='';$('#date-to').value='';renderAnalytics();});
$('#user-search').addEventListener('input',renderUsers);
$('#record-kind').addEventListener('change',()=>{recordLimit=100;renderRecords();});
$('#more-records').addEventListener('click',()=>{recordLimit+=100;renderRecords();});
$('#refresh').addEventListener('click',refresh);
for(const format of ['json','csv']) $('#export-'+format).addEventListener('click',async()=>{
  try {
    const current=await request('data'+(selectedId()?'?participantId='+encodeURIComponent(selectedId()):''));
    download('little-log-'+(selectedId()||'everyone')+'.'+format,format==='json'?JSON.stringify(current,null,2):datasetCsv(current),format==='json'?'application/json':'text/csv;charset=utf-8');
    status('Exported '+current.users.length+' participants, including their full chart definitions.');
  } catch(error) { status(error.message); }
});
$('#user-table').addEventListener('click',async event=>{
  const button=event.target.closest('button'); if(!button) return;
  const id=button.dataset.saveUser??button.dataset.revoke??button.dataset.inspect??button.dataset.prediction,user=users.find(value=>value.id===id);
  if(!user) return;
  if(button.dataset.prediction) { $('#participant-filter').value=id;resetPreview();resetPrediction();renderAnalytics();if(location.hash==='#predictions')void loadPrediction();else location.hash='predictions';return; }
  if(button.dataset.inspect) { $('#participant-filter').value=id; resetPreview();renderAnalytics();location.hash='analytics';return; }
  const row=button.closest('tr'),action=button.dataset.revoke?'revoke':'update';
  const input={id,version:user.version,action,role:row.querySelector('[data-role]').value,disabled:row.querySelector('[data-disabled]').value==='true'};
  if(action==='update' && input.role===user.role && input.disabled===Boolean(user.disabled)) {status('No access changes to save.');return;}
  button.disabled=true;
  try { await request('user',input); await refresh(); if(actor) status('User access updated. Existing Little Log sessions were revoked.'); }
  catch(error) { status(error.message); } finally {button.disabled=false;}
});
$('#admin-workspace').addEventListener('click',event=>{
  const button=event.target.closest('button'); if(!button || !analysis) return;
  const id=button.dataset.svg??button.dataset.graphCsv,graph=analysis.graphs.find(value=>value.id===id); if(!graph) return;
  if(button.dataset.svg) {
    const svg=$('#graph-'+id+' svg[role="img"]'); if(svg) download('little-log-'+id+'.svg',new XMLSerializer().serializeToString(svg),'image/svg+xml');
  } else {
    const cell=value=>{let text=String(value??'');if(/^[=+\-@\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
    download('little-log-'+id+'.csv','\uFEFF'+[graph.columns,...graph.rows].map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  }
});

function resetPrediction() { // Invalidate in-flight responses and clear sensitive model state rather than leaving a hidden previous participant's estimate.
  predictionRequest++;predictionUser='';predictionEntries=null;predictionBusy=false;clearPrediction();
  $('#admin-prediction-card').hidden=true;$('#prediction-selection').textContent='Select an individual participant to view their estimate.';$('#prediction-fetched').textContent='';$('#prediction-refresh').disabled=!actor||!selectedId();
}
async function loadPrediction() { // Fetch just the selected participant through the existing authorized API; date filters never distort the current model.
  const id=selectedId();if(!actor||location.hash!=='#predictions'||!id){resetPrediction();return;}
  if(predictionBusy&&predictionUser===id)return;
  if(predictionUser!==id)resetPrediction();
  predictionUser=id;predictionBusy=true;const sequence=++predictionRequest,epoch=accessEpoch;
  $('#prediction-refresh').disabled=true;
  if(!predictionEntries)$('#prediction-selection').textContent='Loading participant estimate...';
  try {
    const result=await request('data?participantId='+encodeURIComponent(id));
    if(sequence!==predictionRequest||epoch!==accessEpoch||selectedId()!==id||location.hash!=='#predictions')return;
    const user=result.users.find(user=>user.id===id);if(!user)throw Error('Participant no longer available.');
    predictionEntries=user.records.filter(record=>record.entry).map(record=>record.entry);
    $('#prediction-selection').textContent=user.label+' / '+user.id;
    $('#prediction-fetched').textContent='Synced records fetched '+new Date().toLocaleString()+'. Refreshes every 30 seconds while this panel is visible.';
    $('#admin-prediction-card').hidden=false;renderPrediction(predictionEntries,id,true);
  }catch(error){if(sequence===predictionRequest&&epoch===accessEpoch)$('#prediction-fetched').textContent='Could not refresh. '+(predictionEntries?'The previous snapshot is still shown. ':'')+error.message;}
  finally{if(sequence===predictionRequest){predictionBusy=false;$('#prediction-refresh').disabled=false;}}
}
$('#prediction-refresh').addEventListener('click',()=>void loadPrediction());
setInterval(()=>{if(!document.hidden&&location.hash==='#predictions')void loadPrediction();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&location.hash==='#predictions')void loadPrediction();});

window.addEventListener('hashchange',navigate);
window.addEventListener('pagehide',()=>clearPrivateView()); // A shared console should not retain everyone’s records in the back-forward cache.
window.addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
async function checkAccess() { // Revalidate access without erasing a file preview or changing the analyst's current dataset.
  if(!actor || loading) return;
  try { await request('users'); } catch(error) { status(error.message); }
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void checkAccess();void refreshCharts();}});
setInterval(()=>{if(!document.hidden)void checkAccess();},60000);
const today=new Date(),start=new Date(); start.setDate(start.getDate()-29);
const date=value=>new Date(value.getTime()-value.getTimezoneOffset()*60000).toISOString().slice(0,10);
$('#date-from').value=date(start);$('#date-to').value=date(today);
navigate(); void refresh();


function createNoticeEditor(key,label) { // Each notice owns its draft, request state and version, so saving one cannot overwrite the other.
  const field=suffix=>$('#'+key+'-'+suffix);let version=null,busy=false;
  function controls(value) { // Disable edits during a request to preserve text typed before saving.
    busy=value;
    for(const suffix of ['message','enabled','reload'])field(suffix).disabled=busy||!actor;
    field('save').disabled=busy||!actor||version===null;
  }
  function preview() {field('preview').textContent=field('message').value.trim()||'No text yet.';} // Render all authored text literally.
  function render(value) {version=value.version;field('message').value=value.text;field('enabled').checked=value.enabled;preview();}
  async function load() { // Only the explicit reload button replaces an existing unsaved draft.
    if(!actor||busy)return;controls(true);
    try {render(await request(key));field('editor-status').textContent='Loaded current '+label.toLowerCase()+'. Version '+version+'.';}
    catch(error){field('editor-status').textContent=error.message;}
    finally{controls(false);}
  }
  field('message').addEventListener('input',preview);
  field('reload').addEventListener('click',()=>void load());
  field('form').addEventListener('submit',async event=>{ // The shared request helper checks the live admin session and includes CSRF protection.
    event.preventDefault();if(!actor||busy||version===null)return;controls(true);
    try {
      render(await request(key,{text:field('message').value,enabled:field('enabled').checked,version}));
      field('editor-status').textContent=field('enabled').checked?label+' published.':label+' hidden. Text saved for later.';
      if(typeof BroadcastChannel==='function'){const channel=new BroadcastChannel('little-log-reminder');channel.postMessage('updated');channel.close();}
    }catch(error){field('editor-status').textContent=error.message;}
    finally{controls(false);}
  });
  return {loadInitial(){if(version===null)void load();},clear(){version=null;field('message').value='';field('preview').textContent='';field('enabled').checked=false;field('editor-status').textContent='';field('save').disabled=true;}};
}
