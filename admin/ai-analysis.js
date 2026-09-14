export function createAnalysisPanel({request,authorized,download}) { // All requests use the existing admin session, live role checks and CSRF protection.
  const $=id=>document.getElementById('ai-'+id);
  let settings=null,dirty=false,busy=false,epoch=0,requestId=null,requestSharing=false,report=null,nextCursor=null,page=null;
  const message=text=>{$('status').textContent=text;};
  function controls(){for(const id of ['save','reload','run','run-share','refresh','older','token-create'])$(id).disabled=busy||!authorized()||(['run','run-share'].includes(id)&&(!settings||dirty));} // Unsaved prompt changes cannot accidentally launch with an older prompt.
  async function loadTokens(){ // Only token metadata is reloaded; saved credentials cannot be retrieved from the server.
    const version=epoch,value=await request('ai-analysis/tokens');if(version!==epoch||!authorized())return;
    $('api-url').textContent=new URL('../api/ai-reports/v1/reports',location.href).href;
    const list=document.createElement('ul');
    for(const token of value.tokens){const item=document.createElement('li');item.textContent=token.name+' — '+(token.revoked===null?'Active':'Revoked')+' · '+new Date(token.created).toLocaleString()+' ';
      if(token.revoked===null){const button=document.createElement('button');button.type='button';button.className='button secondary small';button.textContent='Revoke';button.addEventListener('click',()=>void perform(async()=>{await request('ai-analysis/tokens/revoke',{id:token.id});hideToken();message('Report token revoked.');await loadTokens();}));item.append(button);}list.append(item);
    }
    $('token-list').replaceChildren(list);if(!value.tokens.length)$('token-list').textContent='No report-read tokens created.';
  }
  function hideToken(){$('token-secret').value='';$('token-result').hidden=true;} // Remove the only browser copy when dismissed or authorization ends.
  function apply(value){settings=value;dirty=false;$('prompt').value=value.prompt;$('days').value=value.lookbackDays;$('tokens').value=value.maxTokens;$('temperature').value=value.temperature;$('model').value=value.model;$('enabled').checked=value.enabled;controls();}
  function renderReport(value){
    report=value;$('report').hidden=false;$('report-title').textContent='AI report — '+value.day;
    $('report-meta').textContent=value.status+' · '+(value.source==='daily'||value.share_with_bot?'MommyBot feed when completed':'Private manual report')+' · '+(value.model_used||'model pending')+' · '+(value.input?'Source captured '+new Date(value.input.capturedAt).toLocaleString():'Source not yet captured');
    $('report-warning').textContent=value.finish_reason==='length'?'This report reached the output token limit and may be incomplete.':'AI-generated analysis. Review findings against the saved statistics.';
    $('document').textContent=value.document||value.error||'The report is still being prepared.';
    $('source').textContent=JSON.stringify({settings:value.settings,statistics:value.input},null,2);$('download').disabled=!value.document;
  }
  async function view(id){const version=epoch;const value=await request('ai-analysis/report?id='+encodeURIComponent(id));if(version===epoch&&authorized())renderReport(value);} // Model-authored Markdown stays literal text; generated HTML never executes.
  function history(jobs){
    const table=document.createElement('table'),head=table.createTHead().insertRow();
    for(const text of ['Report date','Source','Status','Attempts','Actions']){const cell=document.createElement('th');cell.scope='col';cell.textContent=text;head.append(cell);}
    const body=table.createTBody();
    for(const job of jobs){const row=body.insertRow();for(const [index,value] of [job.day,job.source+(job.share_with_bot?' · share with MommyBot':''),job.status+(job.error?' — '+job.error:''),job.attempts].entries()){const cell=row.insertCell();cell.textContent=value;cell.className='wrap';cell.dataset.label=['Report date','Source','Status','Attempts'][index];}
      const cell=row.insertCell();cell.dataset.label='Actions';
      for(const [label,action] of [['View','view'],...(['queued','running'].includes(job.status)?[['Cancel','cancel']]:['failed','cancelled'].includes(job.status)?[['Retry','retry']]:[])]){
        const button=document.createElement('button');button.type='button';button.className='button secondary small';button.textContent=label;
        button.addEventListener('click',()=>void perform(async()=>{if(action==='view')await view(job.id);else{await request('ai-analysis/action',{id:job.id,action});message(action==='cancel'?'Report cancelled.':'Report queued again with its saved prompt and source statistics.');await refresh();if(report?.id===job.id)await view(job.id);}}));cell.append(button);
      }
    }
    $('history').replaceChildren(table);if(!jobs.length)$('history').textContent='No reports yet.';
  }
  async function refresh(reload=false){ // Poll status without overwriting an administrator's prompt draft or current history page.
    const version=epoch,value=await request('ai-analysis'+(page?'?before='+page:''));if(version!==epoch||!authorized())return;
    if(!settings||reload)apply(value.settings);
    $('schedule').textContent=value.settings.enabled?'Next daily report: '+new Date(value.nextRun).toLocaleString('en-US',{timeZone:value.timeZone,timeZoneName:'short'})+'.':'Daily reports are paused. Manual runs remain available.';
    nextCursor=value.nextCursor;$('older').hidden=!nextCursor;history(value.jobs);
    if(!$('day').value){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:value.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));const today=`${parts.year}-${parts.month}-${parts.day}`;$('day').max=today;$('day').value=new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10);}
    if(report&&['queued','running'].includes(report.status))await view(report.id);
    await loadTokens();
  }
  async function perform(action){if(busy||!authorized())return;busy=true;controls();const version=epoch;try{await action();}catch(error){if(version===epoch)message(error.message);}finally{if(version===epoch){busy=false;controls();}}}
  $('settings').addEventListener('input',()=>{dirty=true;requestId=null;message('Save settings before running with this prompt.');controls();});
  $('settings').addEventListener('submit',event=>{event.preventDefault();void perform(async()=>{
    const version=epoch,draft={...settings,prompt:$('prompt').value,lookbackDays:Number($('days').value),model:$('model').value,maxTokens:Number($('tokens').value),temperature:Number($('temperature').value),enabled:$('enabled').checked};
    const value=await request('ai-analysis/settings',draft);if(version!==epoch)return;apply(value);message('Analysis settings saved.');await refresh();
  });});
  $('run-form').addEventListener('submit',event=>{event.preventDefault();if(dirty||!settings)return;const shareWithBot=event.submitter?.id==='ai-run-share';void perform(async()=>{
    const version=epoch;if(requestSharing!==shareWithBot)requestId=null;requestSharing=shareWithBot;requestId??=crypto.randomUUID(); // Changing the sharing choice starts a new request instead of reusing an uncertain previous submission.
    const job=await request('ai-analysis/run',{requestId,day:$('day').value,shareWithBot});if(version!==epoch)return;requestId=null;
    message(shareWithBot?'Report queued for MommyBot. It will appear in the polling feed after completion.':'Report queued. You can close this page while it runs.');page=null;await refresh();if(version===epoch)await view(job.id);
  });});
  $('day').addEventListener('input',()=>{requestId=null;});
  $('reload').addEventListener('click',()=>void perform(()=>refresh(true)));
  $('refresh').addEventListener('click',()=>void perform(()=>{page=null;return refresh();}));
  $('older').addEventListener('click',()=>void perform(()=>{page=nextCursor;return refresh();}));
  $('token-form').addEventListener('submit',event=>{event.preventDefault();void perform(async()=>{
    const version=epoch;hideToken();const result=await request('ai-analysis/tokens',{name:$('token-name').value});if(version!==epoch||!authorized())return;
    $('token-secret').value=result.token;$('token-result').hidden=false;message('Read-only report token created. Copy it before leaving this page.');await loadTokens();
  });});
  $('token-hide').addEventListener('click',hideToken);
  $('download').addEventListener('click',()=>{if(report?.document&&authorized())download('little-log-ai-'+report.day+'-'+report.id+'.md',
    '# Little Log AI report — '+report.day+'\n\nAI-generated; review against source statistics.\n\nModel: '+report.model_used+'\n\nCompletion: '+report.finish_reason+'\n\n'+report.document+'\n\n## Saved configuration and source statistics\n\n```json\n'+JSON.stringify({settings:report.settings,statistics:report.input},null,2)+'\n```\n','text/markdown;charset=utf-8');});
  const load=()=>perform(()=>refresh());
  setInterval(()=>{if(location.hash==='#ai-analysis'&&!document.hidden)void load();},5000);
  return {load,clear(){epoch++;settings=null;dirty=false;busy=false;requestId=null;report=null;nextCursor=null;page=null;$('settings').reset();$('day').value='';hideToken();$('token-form').reset();for(const id of ['history','document','source','schedule','status','report-meta','report-warning','token-list','api-url'])$(id).textContent='';$('report').hidden=true;controls();}};
}
