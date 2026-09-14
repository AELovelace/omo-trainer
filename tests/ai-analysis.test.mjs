import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {analysisDay,nextAnalysisMidnight,runAnalysisJob} from '../server/ai-analysis.mjs';

function fixture(filename=':memory:') { // Use synthetic identities and a controlled clock; no test calls the configured LAN endpoint.
  let clock=Date.parse('2026-09-14T06:59:59Z');
  const db=openDatabase(filename,{aiAnalysis:{now:()=>clock}}),admin=db.ensureParticipant('test','admin','Admin'),member=db.ensureParticipant('test','member','Private name');db.admin.bootstrap(admin.id);
  return {db,admin,member,store:db.aiAnalysis,setTime:value=>{clock=typeof value==='number'?value:Date.parse(value);}};
}
const queue=(f,extra={})=>f.store.queue(f.admin.id,{requestId:crypto.randomUUID(),day:'2026-09-12',...extra});
const observation=(id,liquidsMl,time='10:00:00')=>({id,kind:'observation',occurredAt:'2026-09-12T'+time+'-07:00',liquidsMl,liquidsMode:'interval',diaperNumber:1,edited:false});
function put(f,entry) {f.db.sync(f.member.id,[{id:entry.id,entry,mutationId:crypto.randomUUID(),baseVersion:0}]);}
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const complete=()=>response({model:'synthetic-model',choices:[{message:{content:'# Report\n\nSynthetic result.'},finish_reason:'stop'}]});
const stub=async(url)=>url.endsWith('/models')?response({data:[{id:'synthetic-model'}]}):complete();

test('Los Angeles midnight follows spring/fall DST and date rollover',()=>{
  for(const [start,end,hours] of [['2026-03-08T08:00:00Z','2026-03-09T07:00:00Z',23],['2026-11-01T07:00:00Z','2026-11-02T08:00:00Z',25],['2026-12-31T08:00:00Z','2027-01-01T08:00:00Z',24]]){
    const next=nextAnalysisMidnight(Date.parse(start));assert.equal(new Date(next).toISOString(),new Date(end).toISOString());assert.equal(next-Date.parse(start),hours*3600000);
  }
  assert.equal(analysisDay(Date.parse('2026-09-14T06:59:59Z')),'2026-09-13');
  assert.equal(analysisDay(Date.parse('2026-09-14T07:00:00Z')),'2026-09-14');
});

test('scheduler starts next midnight, deduplicates, catches up latest day only and respects pause',()=>{
  const f=fixture();try{
    f.store.schedule();assert.equal(f.store.overview(f.admin.id).jobs.length,0);
    f.setTime('2026-09-14T07:00:00Z');f.store.schedule();f.store.schedule();
    let jobs=f.store.overview(f.admin.id).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].day,'2026-09-13');assert.equal(jobs[0].source,'daily');
    f.setTime('2026-09-18T08:00:00Z');f.store.schedule();jobs=f.store.overview(f.admin.id).jobs;assert.equal(jobs.length,2);assert.equal(jobs[0].day,'2026-09-17');
    f.store.save(f.admin.id,{...f.store.overview(f.admin.id).settings,enabled:false});f.setTime('2026-09-19T08:00:00Z');f.store.schedule();assert.equal(f.store.overview(f.admin.id).jobs.length,2);
    queue(f);assert.equal(f.store.overview(f.admin.id).jobs.length,3,'Paused schedules still allow manual runs');
  }finally{f.db.close();}
});

test('settings validate and use optimistic versions; queue retries preserve their original prompt',()=>{
  const f=fixture();try{
    const previous=f.store.overview(f.admin.id).settings;
    assert.throws(()=>f.store.save(f.member.id,previous),error=>error.status===403);
    for(const value of [{prompt:''},{maxTokens:Infinity},{lookbackDays:32},{temperature:-1},{enabled:'yes'},{model:null}])assert.throws(()=>f.store.save(f.admin.id,{...previous,...value}),error=>error.status===400);
    const input={requestId:crypto.randomUUID(),day:'2026-09-12'},first=f.store.queue(f.admin.id,input);
    f.store.save(f.admin.id,{...previous,prompt:'Compare daily intake.'});assert.throws(()=>f.store.save(f.admin.id,previous),error=>error.status===409);
    assert.equal(f.store.queue(f.admin.id,input).id,first.id);assert.equal(f.store.report(f.admin.id,first.id).settings.prompt,previous.prompt);
    assert.equal(f.store.report(f.admin.id,queue(f).id).settings.prompt,'Compare daily intake.');
    for(const day of ['2026-02-30','2026-09-99','9999-01-01','bad'])assert.throws(()=>queue(f,{day}),error=>error.status===400);
    assert.ok(f.db.admin.auditList(f.admin.id).some(row=>row.action==='ai-settings'));
  }finally{f.db.close();}
});

test('aggregation preserves intake semantics, separates categories and excludes identities and deleted records',()=>{
  const f=fixture();try{
    put(f,{id:'legacy',occurredAt:'2026-09-12T11:00:00-07:00',liquidsMl:500,position:'sitting',diaperNumber:1,wettingsCount:9,probability:50,result:'pee',source:'manual',edited:false});
    put(f,observation('early',100));put(f,observation('later',200,'12:00:00'));
    for(const [id,category] of [['bed','bedwetting'],['potty','used-the-potty']])put(f,{id,kind:'wetting',occurredAt:'2026-09-12T14:00:00-07:00',category,position:'sitting',diaperNumber:1,wettingsCount:1,edited:false});
    put(f,observation('deleted',999,'16:00:00'));f.db.sync(f.member.id,[{id:'deleted',entry:null,baseVersion:1,mutationId:crypto.randomUUID()}]);
    const queued=queue(f),claimed=f.store.claim('one'),input=f.store.snapshot(claimed.id,'one'),day=input.days.at(-1);
    assert.equal(day.liquidsMl,700);assert.equal(day.observations,3);assert.equal(day.wettings,2);assert.equal(day.categories.bedwetting,1);assert.equal(day.categories['used-the-potty'],1);assert.equal(day.activeParticipants,1);
    assert.equal(day.randomPeeResults,0);assert.equal(input.days.length,7);
    const encoded=JSON.stringify(input);assert.ok(!encoded.includes(f.member.id));assert.ok(!encoded.includes('Private name'));assert.ok(!encoded.includes('"id"'));
    put(f,observation('new-after-snapshot',500,'17:00:00'));assert.deepEqual(f.store.snapshot(queued.id,'one'),input);
  }finally{f.db.close();}
});

test('single worker leases recover crashes, survive reopening and reject stale completions',()=>{
  const directory=mkdtempSync(join(tmpdir(),'little-log-ai-')),filename=join(directory,'science.sqlite');
  const f=fixture(filename);let second;
  try{
    const first=queue(f);queue(f);const claimed=f.store.claim('old');assert.equal(claimed.id,first.id);assert.equal(f.store.claim('other'),null);
    second=openDatabase(filename,{aiAnalysis:{now:()=>Date.parse('2026-09-14T07:02:00Z')}});
    const recovered=second.aiAnalysis.claim('new');assert.equal(recovered.id,first.id);assert.equal(recovered.attempts,2);
    assert.equal(f.store.finish(first.id,'old',{document:'stale',model:'test',finishReason:'stop'}),0);
    second.aiAnalysis.finish(first.id,'new',{document:'saved',model:'test',finishReason:'stop'});
    second.close();second=null;
    const reopened=openDatabase(filename);try{assert.equal(reopened.aiAnalysis.report(f.admin.id,first.id).document,'saved');}finally{reopened.close();}
  }finally{second?.close();f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('SQL-only legacy snapshots and saved chart stars remain available to AI summaries',()=>{
  const directory=mkdtempSync(join(tmpdir(),'little-log-ai-legacy-')),filename=join(directory,'science.sqlite'),f=fixture(filename);
  try{
    put(f,{id:'legacy',occurredAt:'2026-09-12T11:00:00-07:00',liquidsMl:500,position:'sitting',diaperNumber:1,wettingsCount:9,probability:50,result:'pee',source:'random',edited:false});
    f.db.saveGrowthChart(f.member.id,{baseVersion:0,mutationId:'chart-test',chart:{name:'Private chart name',since:'2026-09-01',refusals:0,escaped:false,rows:[{id:'private-row',label:'Private goal',note:'Private note',locked:false},{id:'potty',label:'Locked',note:'',locked:true}],stars:{'2026-09-12:private-row':true}}});
    const raw=new DatabaseSync(filename);try{raw.prepare('UPDATE entries SET payload_json=NULL WHERE id=?').run('legacy');}finally{raw.close();}
    queue(f);const job=f.store.claim('worker'),input=f.store.snapshot(job.id,'worker'),day=input.days.at(-1);
    assert.equal(day.liquidsMl,500);assert.equal(day.observations,1);assert.equal(day.randomRolls,1);assert.equal(day.randomPeeResults,1);assert.equal(day.chartStars,1);assert.ok(!JSON.stringify(input).includes('Private'));
  }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('pending work is bounded while completed reports remain accessible through history pages',()=>{
  const f=fixture();try{
    for(let i=0;i<20;i++)queue(f);assert.throws(()=>queue(f),error=>error.status===409);
    for(let i=0;i<55;i++){const job=f.store.claim('worker');f.store.finish(job.id,'worker',{document:'saved',model:'fixture',finishReason:'stop'});if(i<54)queue(f);}
    const recent=f.store.overview(f.admin.id),older=f.store.overview(f.admin.id,{before:recent.nextCursor});assert.equal(recent.jobs.length,50);assert.ok(older.jobs.length>0);assert.equal(new Set([...recent.jobs,...older.jobs].map(job=>job.id)).size,recent.jobs.length+older.jobs.length);
  }finally{f.db.close();}
});

test('background inference records model and finish reason, and cancelled jobs cannot finish',async()=>{
  const f=fixture();try{
    const first=queue(f),job=f.store.claim('worker');let sent;
    await runAnalysisJob(f.store,job,'worker',{fetcher:async(url,options)=>{if(url.endsWith('/models'))return response({data:[{id:'fixture'}]});sent=JSON.parse(options.body);return response({model:'fixture',choices:[{message:{content:'# Partial report'},finish_reason:'length'}]});}});
    const report=f.store.report(f.admin.id,first.id);assert.equal(report.status,'completed');assert.equal(report.finish_reason,'length');assert.equal(report.model_used,'fixture');assert.equal(sent.stream,false);assert.equal(sent.messages[0].role,'system');assert.ok(!JSON.stringify(sent).includes(f.member.id));
    const next=queue(f),nextJob=f.store.claim('worker');await runAnalysisJob(f.store,nextJob,'worker',{fetcher:async()=>{f.store.change(f.admin.id,{id:next.id,action:'cancel'});return response({data:[{id:'fixture'}],choices:[{message:{content:'late'},finish_reason:'stop'}]});}});
    assert.equal(f.store.report(f.admin.id,next.id).status,'cancelled');assert.equal(f.store.report(f.admin.id,next.id).document,null);
    f.store.change(f.admin.id,{id:next.id,action:'retry'});await runAnalysisJob(f.store,f.store.claim('worker'),'worker',{fetcher:stub});assert.equal(f.store.report(f.admin.id,next.id).status,'completed');
  }finally{f.db.close();}
});

test('failed inference retries with backoff, stops at three attempts and stores no upstream body',async()=>{
  const f=fixture();try{
    const first=queue(f);
    for(let i=0;i<3;i++){
      const job=f.store.claim('worker');assert.ok(job);await runAnalysisJob(f.store,job,'worker',{fetcher:async()=>response({secret:'not for logs'},503)});
      const report=f.store.report(f.admin.id,first.id);assert.equal(report.status,i===2?'failed':'queued');assert.equal(report.error,'Inference endpoint returned HTTP 503.');assert.equal(f.store.claim('worker'),null);
      f.setTime(Date.parse('2026-09-14T06:59:59Z')+(i+1)*300000);
    }
    assert.equal(f.store.report(f.admin.id,first.id).attempts,3);
  }finally{f.db.close();}
});

test('malformed, empty and oversized model output produce retryable failures',async()=>{
  for(const fake of [async()=>new Response('{bad'),async()=>response({choices:[{message:{content:''}}]}),async()=>new Response('x'.repeat(2*1024*1024+1))]){
    const f=fixture();try{f.store.save(f.admin.id,{...f.store.overview(f.admin.id).settings,model:'fixture'});const job=queue(f);await runAnalysisJob(f.store,f.store.claim('worker'),'worker',{fetcher:fake});const saved=f.store.report(f.admin.id,job.id);assert.equal(saved.status,'queued');assert.equal(saved.document,null);assert.ok(saved.error);}finally{f.db.close();}
  }
});

test('native HTTP transport accepts delayed responses and applies its independent deadline',async()=>{
  const f=fixture();let hang=false;
  const endpoint=createServer((req,res)=>{if(hang)return;setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:'fixture'}]}:{choices:[{message:{content:'Delayed report'},finish_reason:'stop'}]}));},40);});
  await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
  try{
    const url='http://127.0.0.1:'+endpoint.address().port,first=queue(f);
    await runAnalysisJob(f.store,f.store.claim('worker'),'worker',{endpoint:url,timeoutMs:3000});assert.equal(f.store.report(f.admin.id,first.id).document,'Delayed report');
    hang=true;const next=queue(f);await runAnalysisJob(f.store,f.store.claim('worker'),'worker',{endpoint:url,timeoutMs:50});assert.match(f.store.report(f.admin.id,next.id).error,/time limit/);
  }finally{endpoint.closeAllConnections();await new Promise(resolve=>endpoint.close(resolve));f.db.close();}
});

test('every analysis route is admin-only, mutations require CSRF, and enqueue returns 202 before inference',async()=>{
  const f=fixture(),token=f.db.createSession(f.admin.id),ordinary=f.db.createSession(f.member.id);
  const login={origin:'',session:req=>f.db.session(req.headers.cookie)},api=createApi(f.db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));login.origin='http://127.0.0.1:'+server.address().port;
  const routes=[['ai-analysis','GET'],['ai-analysis/report?id=missing','GET'],['ai-analysis/settings','POST'],['ai-analysis/run','POST'],['ai-analysis/action','POST']];
  try{
    for(const [route,method] of routes){for(const [cookie,status] of [[undefined,401],[ordinary,403]]){
      const result=await fetch(login.origin+'/admin/'+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{'Content-Type':'application/json',Origin:login.origin,'X-CSRF-Token':cookie?f.db.session(cookie).csrf:''}:{})},...(method==='POST'?{body:'{}'}:{})});assert.equal(result.status,status,route);
    }}
    const headers={Cookie:token,Origin:login.origin,'Content-Type':'application/json'},payload=JSON.stringify({requestId:crypto.randomUUID(),day:'2026-09-12'});
    assert.equal((await fetch(login.origin+'/admin/ai-analysis/run',{method:'POST',headers,body:payload})).status,403);
    headers['X-CSRF-Token']=f.db.session(token).csrf;
    const result=await fetch(login.origin+'/admin/ai-analysis/run',{method:'POST',headers,body:payload});assert.equal(result.status,202);assert.equal(result.headers.get('cache-control'),'no-store');const job=await result.json();assert.equal(job.status,'queued');assert.equal(job.attempts,0);
    const report=await fetch(login.origin+'/admin/ai-analysis/report?id='+job.id,{headers:{Cookie:token}});assert.equal(report.status,200);assert.equal(report.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(login.origin+'/ai-analysis',{headers:{Cookie:ordinary}})).status,404,'No participant analysis API exists');
  }finally{await new Promise(resolve=>server.close(resolve));f.db.close();}
});
