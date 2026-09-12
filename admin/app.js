import { analyzeDataset } from '../lib/admin-analytics.js';
import { datasetCsv } from '../lib/admin-format.js';

const $=selector=>document.querySelector(selector);
const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); // Escape user-authored labels before creating HTML or SVG.
const colors=['#ff96c8','#b3a4f4','#ffe66f','#7fd9c7'];
const fmt=value=>typeof value==='number'?Number(value.toFixed(2)).toLocaleString():String(value??'');
let csrf='',actor=null,users=[],dataset=null,analysis=null,preview=null,recordLimit=100,loading=false,accessEpoch=0;
const selectedId=()=>$('#participant-filter').value;
const cohort=()=>({...dataset,users:dataset.users.filter(user=>!selectedId() || user.id===selectedId())});

function clearPrivateView() { // Drop all in-memory cohort data and rendered records when authorization ends; never persist administrator datasets in browser storage.
  accessEpoch++; csrf=''; actor=null; users=[]; dataset=null; analysis=null; preview=null;
  for(const selector of ['#graphs','#user-table','#chart-lines','#participant-snapshots','#record-table','#audit-table','#admin-summary','#import-preview']) $(selector).replaceChildren();
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
  const y=value=>top+ph-(Number(value)/max)*ph;
  let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+w+' '+h+'" role="img" aria-label="'+escape(graph.title)+'"><title>'+escape(graph.title)+'</title><rect width="'+w+'" height="'+h+'" fill="#260b20"/>';
  for(let i=0;i<=4;i++) {
    const value=max*i/4,py=y(value);
    svg+='<path d="M'+left+' '+py+'H'+(w-right)+'" stroke="#5f344e"/><text x="'+(left-8)+'" y="'+(py+4)+'" text-anchor="end" fill="#cca9bd" font-size="11">'+escape(fmt(value))+'</text>';
  }
  if(graph.type==='scatter') {
    for(const row of rows) svg+='<circle cx="'+(left+Number(row[1])/maxX*pw)+'" cy="'+y(row[2])+'" r="4" fill="#ff96c8" opacity=".65"><title>'+escape(row[0]+': '+fmt(row[1])+' mL, '+fmt(row[2])+' events')+'</title></circle>';
    svg+='<text x="'+left+'" y="'+(h-34)+'" fill="#cca9bd" font-size="11">0</text><text x="'+(w-right)+'" y="'+(h-34)+'" text-anchor="end" fill="#cca9bd" font-size="11">'+escape(fmt(maxX))+'</text><text x="'+(w/2)+'" y="'+(h-10)+'" text-anchor="middle" fill="#cca9bd" font-size="12">Logged intake (mL)</text>';
  } else {
    const step=pw/Math.max(1,rows.length),x=i=>left+step*(i+.5);
    for(const [series,col] of cols.entries()) {
      const color=colors[series%colors.length];
      if(graph.type==='line') {
        svg+='<polyline fill="none" stroke="'+color+'" stroke-width="2" points="'+rows.map((row,i)=>x(i)+','+y(row[col])).join(' ')+'"/>';
        svg+=rows.map((row,i)=>'<circle cx="'+x(i)+'" cy="'+y(row[col])+'" r="3" fill="'+color+'"><title>'+escape(row[0]+' / '+graph.columns[col]+': '+fmt(row[col]))+'</title></circle>').join('');
      } else {
        const bw=step*.76/cols.length;
        svg+=rows.map((row,i)=>'<rect x="'+(left+i*step+step*.12+series*bw)+'" y="'+y(row[col])+'" width="'+Math.max(.1,bw-1)+'" height="'+Math.max(0,top+ph-y(row[col]))+'" fill="'+color+'"><title>'+escape(row[0]+' / '+graph.columns[col]+': '+fmt(row[col]))+'</title></rect>').join('');
      }
    }
    const stride=Math.max(1,Math.ceil(rows.length/7));
    rows.forEach((row,i)=>{if(i%stride===0) svg+='<text x="'+x(i)+'" y="'+(h-34)+'" text-anchor="middle" fill="#cca9bd" font-size="10">'+escape(String(row[0]).slice(0,18))+'</text>';});
  }
  svg+='</svg>';
  if(graph.rows.length>limit) svg+='<p>Plot shows '+(graph.type==='line'?'the latest ':'the first ')+limit+' rows. Exact data and exports include all '+graph.rows.length+' rows.</p>';
  return svg;
}
function renderAnalytics() { // Date and participant filters recompute charts locally without changing or uploading records.
  if(!dataset) return;
  const from=$('#date-from').value,to=$('#date-to').value;
  if(from && to && from>to) { status('Analysis start must be on or before its end.'); return; }
  analysis=analyzeDataset(cohort(),{from,to,interval:$('#interval').value});
  const t=analysis.totals;
  $('#admin-summary').innerHTML=[['Participants',t.users],['Observations',t.observations],['Classified wettings',t.wettings],['Random rolls',t.randomRolls],['Logged intake (mL)',t.liquids],['Chart stars',t.stars]].map(([label,n])=>'<article><strong>'+escape(fmt(n))+'</strong><span>'+label+'</span></article>').join('');
  $('#graphs').innerHTML=analysis.graphs.map(graph=>{
    const cols=graph.plotColumns??graph.columns.slice(1).map((_,i)=>i+1);
    return '<article class="card admin-graph" id="graph-'+graph.id+'"><h3>'+escape(graph.title)+'</h3><p>'+escape(graph.description)+'</p>'+plot(graph)+
      '<div class="admin-legend">'+(graph.type==='scatter'?'':cols.map((i,n)=>'<span><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" fill="'+colors[n%colors.length]+'"/></svg> '+escape(graph.columns[i])+'</span>').join(''))+'</div>'+
      '<details><summary>Exact data ('+graph.rows.length+' rows)</summary><div class="table-scroll">'+table(graph.columns,graph.rows)+'</div></details><div class="admin-buttons"><button class="button secondary small" data-svg="'+graph.id+'">Download SVG</button><button class="button secondary small" data-graph-csv="'+graph.id+'">Data CSV</button></div></article>';
  }).join('');
  $('#chart-lines').innerHTML=table(['Participant','Participant ID','Row ID','Label','Note','Stars','Status'],analysis.chartRows);
  $('#participant-snapshots').innerHTML=table(['Participant','ID','Enrolled','Timezone','Current chance (%)','Chart since','Chart saved','Refusals','Revealed'],analysis.summaries.map(u=>[u.label,u.id,u.enrolled,u.timezone,u.probability,u.chartSince,u.chartUpdated,u.refusals,u.revealed]));
  recordLimit=100; renderRecords();
}
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
  $('#user-table').innerHTML='<table><thead><tr><th>User</th><th>Records / chart</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>'+selected.map(user=>'<tr data-user="'+escape(user.id)+'"><td>'+escape(user.label)+(user.id===actor?.id?' (you)':'')+'<br><small>'+escape(user.id)+'</small><details><summary>Verified identity</summary><p>'+escape(user.issuer)+'<br>'+escape(user.subject)+'</p></details></td><td>'+user.recordCount+' records<br>'+(user.hasChart?'Chart linked':'No chart')+'</td><td><select data-role aria-label="Role for '+escape(user.label)+'"><option value="participant"'+(user.role==='participant'?' selected':'')+'>Participant</option><option value="admin"'+(user.role==='admin'?' selected':'')+'>Admin</option></select></td><td><select data-disabled aria-label="Access for '+escape(user.label)+'"><option value="false"'+(!user.disabled?' selected':'')+'>Enabled</option><option value="true"'+(user.disabled?' selected':'')+'>Disabled</option></select></td><td><div class="admin-buttons"><button class="button primary small" data-save-user="'+escape(user.id)+'">Save access</button><button class="button secondary small" data-revoke="'+escape(user.id)+'">Revoke sessions</button><button class="button secondary small" data-inspect="'+escape(user.id)+'">View data</button></div></td></tr>').join('')+'</tbody></table>';
}
async function renderAudit() {
  const result=await request('audit');
  $('#audit-table').innerHTML=table(['When','Actor','Action','Target','Details'],result.audit.map(row=>[row.created_at,users.find(user=>user.id===row.actor_id)?.label??row.actor_id,row.action,row.target_id,row.details_json]));
}
function navigate() {
  const route=['analytics','users','transfer','audit'].includes(location.hash.slice(1))?location.hash.slice(1):'analytics';
  document.querySelectorAll('[data-panel]').forEach(panel=>panel.hidden=panel.dataset.panel!==route);
  document.querySelectorAll('[data-tab]').forEach(link=>{ if(link.dataset.tab===route) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
  if(route==='audit' && actor) void renderAudit().catch(error=>status(error.message));
}
function resetPreview() { preview=null; $('#import-preview').textContent=''; $('#apply-import').hidden=true; }
async function refresh() { // Fetch shared records only after a successful server-side admin check.
  if(loading) return;
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
$('#participant-filter').addEventListener('change',()=>{resetPreview();renderAnalytics();});
for(const selector of ['#date-from','#date-to','#interval']) $(selector).addEventListener('change',renderAnalytics);
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
  const id=button.dataset.saveUser??button.dataset.revoke??button.dataset.inspect,user=users.find(value=>value.id===id);
  if(!user) return;
  if(button.dataset.inspect) { $('#participant-filter').value=id; resetPreview();renderAnalytics();location.hash='analytics';return; }
  const row=button.closest('tr'),action=button.dataset.revoke?'revoke':'update';
  const input={id,version:user.version,action,role:row.querySelector('[data-role]').value,disabled:row.querySelector('[data-disabled]').value==='true'};
  if(action==='update' && input.role===user.role && input.disabled===Boolean(user.disabled)) {status('No access changes to save.');return;}
  button.disabled=true;
  try { await request('user',input); await refresh(); if(actor) status('User access updated. Existing Little Log sessions were revoked.'); }
  catch(error) { status(error.message); } finally {button.disabled=false;}
});
$('#graphs').addEventListener('click',event=>{
  const button=event.target.closest('button'); if(!button || !analysis) return;
  const id=button.dataset.svg??button.dataset.graphCsv,graph=analysis.graphs.find(value=>value.id===id); if(!graph) return;
  if(button.dataset.svg) {
    const svg=$('#graph-'+id+' svg[role="img"]'); if(svg) download('little-log-'+id+'.svg',new XMLSerializer().serializeToString(svg),'image/svg+xml');
  } else {
    const cell=value=>{let text=String(value??'');if(/^[=+\-@\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
    download('little-log-'+id+'.csv','\uFEFF'+[graph.columns,...graph.rows].map(row=>row.map(cell).join(',')).join('\r\n'),'text/csv;charset=utf-8');
  }
});
window.addEventListener('hashchange',navigate);
window.addEventListener('pagehide',()=>clearPrivateView()); // A shared console should not retain everyone’s records in the back-forward cache.
window.addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
async function checkAccess() { // Revalidate access without erasing a file preview or changing the analyst's current dataset.
  if(!actor || loading) return;
  try { await request('users'); } catch(error) { status(error.message); }
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void checkAccess();});
setInterval(()=>{if(!document.hidden)void checkAccess();},60000);
const today=new Date(),start=new Date(); start.setDate(start.getDate()-29);
const date=value=>new Date(value.getTime()-value.getTimezoneOffset()*60000).toISOString().slice(0,10);
$('#date-from').value=date(start);$('#date-to').value=date(today);
navigate(); void refresh();
