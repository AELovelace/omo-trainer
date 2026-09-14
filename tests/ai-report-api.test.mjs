import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {runAnalysisJob} from '../server/ai-analysis.mjs';

function fixture(filename=':memory:'){ // Synthetic users and an injectable clock cover API expiry/retry ordering without a live model or Discord connection.
  let now=Date.parse('2026-09-14T12:00:00Z');const db=openDatabase(filename,{stickerCatalog:[],aiAnalysis:{now:()=>now}});
  const admin=db.ensureParticipant('test','admin','Admin'),member=db.ensureParticipant('test','member','Member');db.admin.bootstrap(admin.id);
  const store=db.aiAnalysis,access=store.integrations;
  return {db,admin,member,store,access,advance:ms=>{now+=ms;},queue:()=>store.queue(admin.id,{requestId:crypto.randomUUID(),day:'2026-09-13'})};
}
function complete(f,id,text='# Report',reason='stop'){return f.store.finish(id,'worker',{document:text,model:'synthetic',finishReason:reason});} // Exercise the production completion transaction, including the feed cursor.

test('50,000 tokens is the default and upper bound, is sent to inference, and permits long report documents',async()=>{
  const f=fixture();try{
    const settings=f.store.overview(f.admin.id).settings;assert.equal(settings.maxTokens,50000);
    for(const maxTokens of [50001,255,50000.5])assert.throws(()=>f.store.save(f.admin.id,{...settings,maxTokens}),error=>error.status===400);
    f.store.save(f.admin.id,{...settings,maxTokens:50000,model:'synthetic'});const job=f.queue(),text='Report text. '.repeat(20000);let input;
    await runAnalysisJob(f.store,f.store.claim('worker'),'worker',{fetcher:async(_url,options)=>{input=JSON.parse(options.body);return new Response(JSON.stringify({model:'synthetic',choices:[{message:{content:text},finish_reason:'length'}]}));}});
    assert.equal(input.max_tokens,50000);assert.equal(f.store.report(f.admin.id,job.id).document,text);
    const token=f.access.create(f.admin.id,{name:'MommyBot'}).token;const exported=f.access.report(token,job.id);assert.equal(exported.document,text);assert.equal(exported.incomplete,true);
  }finally{f.db.close();}
});

test('upgrading raises active settings once, retains prompt snapshots and backfills completed documents without changing cursors',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ai-report-upgrade-')),filename=join(directory,'science.sqlite');let f=fixture(filename);
  try{
    f.store.save(f.admin.id,{...f.store.overview(f.admin.id).settings,maxTokens:16384,prompt:'Original custom prompt.'});
    const done=f.queue();f.store.claim('worker');complete(f,done.id);const pending=f.queue();
    const token=f.access.create(f.admin.id,{name:'MommyBot'}).token,actor=f.admin.id;f.db.close();
    const raw=new DatabaseSync(filename);try{raw.exec("DELETE FROM ai_analysis_migrations WHERE name='output-limit-50000'; DELETE FROM ai_report_feed");}finally{raw.close();}
    f=fixture(filename);let settings=f.store.overview(actor).settings;assert.equal(settings.maxTokens,50000);assert.equal(settings.prompt,'Original custom prompt.');assert.equal(f.store.report(actor,pending.id).settings.maxTokens,16384);
    const before=f.access.feed(token);assert.equal(before.reports.length,1);assert.equal(before.reports[0].id,done.id);
    f.store.save(actor,{...settings,maxTokens:1024});f.db.close();f=fixture(filename);
    assert.equal(f.store.overview(actor).settings.maxTokens,1024);assert.deepEqual(f.access.feed(token),before);
  }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('polling follows completion order across failed attempts, repeated reads and late completion of older jobs',()=>{
  const f=fixture();try{
    const token=f.access.create(f.admin.id,{name:'MommyBot'}).token,old=f.queue();f.store.claim('worker');f.store.fail(old.id,'worker','Temporary failure.');
    const newer=f.queue();assert.equal(f.store.claim('worker').id,newer.id);complete(f,newer.id);
    const first=f.access.feed(token,{after:'0',limit:'1'});assert.equal(first.reports[0].id,newer.id);assert.equal(first.has_more,false);assert.equal(first.next_cursor,first.latest_cursor);
    f.advance(300001);assert.equal(f.store.claim('worker').id,old.id);complete(f,old.id,'Older job completed later.');
    const later=f.access.feed(token,{after:first.next_cursor});assert.equal(later.reports.length,1);assert.equal(later.reports[0].id,old.id);assert.ok(later.next_cursor>first.next_cursor);
    assert.deepEqual(f.access.feed(token,{after:first.next_cursor}),later,'Reading does not consume reports');
    assert.equal(complete(f,old.id,'Stale replacement'),0);assert.equal(f.access.report(token,old.id).document,'Older job completed later.');
    assert.equal(f.access.feed(token,{limit:1}).has_more,true);assert.equal(f.access.feed(token,{after:later.next_cursor}).reports.length,0);
    for(const input of [{after:'-1'},{after:'1.5'},{after:'Infinity'},{limit:'0'},{limit:101},{after:'9007199254740992'}])assert.throws(()=>f.access.feed(token,input),error=>error.status===400);
    const queued=f.queue();assert.throws(()=>f.access.report(token,queued.id),error=>error.status===404);
    const metadata=f.access.feed(token).reports[0];for(const field of ['document','settings','input','owner','actor_id'])assert.equal(field in metadata,false);
    const exported=f.access.report(token,newer.id);for(const field of ['settings','input','owner','actor_id'])assert.equal(field in exported,false);
  }finally{f.db.close();}
});

test('report tokens are admin-issued, digest-only, read-only and immediately blocked on revocation or role changes',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ai-report-tokens-')),f=fixture(join(directory,'science.sqlite'));
  try{
    assert.throws(()=>f.access.create(f.member.id,{name:'Not admin'}),error=>error.status===403);
    const issued=f.access.create(f.admin.id,{name:'MommyBot'}),second=f.access.create(f.admin.id,{name:'Other integration'});
    assert.equal(f.access.list(f.admin.id).some(row=>Object.values(row).includes(issued.token)),false);
    const raw=new DatabaseSync(join(directory,'science.sqlite'));try{const row=raw.prepare('SELECT * FROM ai_report_tokens WHERE id=?').get(issued.id);assert.equal(row.token_hash.length,64);assert.equal(Object.values(row).includes(issued.token),false);}finally{raw.close();}
    assert.ok(!JSON.stringify(f.db.admin.auditList(f.admin.id)).includes(issued.token));assert.equal(f.access.feed(issued.token).reports.length,0);
    f.access.revoke(f.admin.id,{id:issued.id});f.access.revoke(f.admin.id,{id:issued.id});assert.throws(()=>f.access.feed(issued.token),error=>error.status===401);
    f.db.admin.updateUser(f.admin.id,{id:f.member.id,action:'update',version:0,role:'admin',disabled:false});
    f.db.admin.updateUser(f.member.id,{id:f.admin.id,action:'update',version:1,role:'participant',disabled:false});
    assert.throws(()=>f.access.feed(second.token),error=>error.status===403);
    const enabled=f.access.create(f.member.id,{name:'Current admin'});assert.equal(f.access.feed(enabled.token).reports.length,0);
  }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('external report HTTP API rejects browser cookies, wallet tokens, mutations and cross-origin requests',async()=>{
  const f=fixture(),session=f.db.createSession(f.admin.id),ordinary=f.db.createSession(f.member.id),token=f.access.create(f.admin.id,{name:'MommyBot'}).token;
  const job=f.queue();f.store.claim('worker');complete(f,job.id);
  const login={origin:'',session:req=>f.db.session(req.headers.cookie)},api=createApi(f.db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));login.origin='http://127.0.0.1:'+server.address().port;
  const get=(path,headers={})=>fetch(login.origin+'/'+path,{headers}),path='ai-reports/v1/reports',headers={Authorization:'Bearer '+token};
  try{
    for(const wrong of [{},{Cookie:session},{Authorization:'Bearer ordinary-wallet-token'}])assert.equal((await get(path,wrong)).status,401);
    assert.equal((await get(path+'?token='+encodeURIComponent(token))).status,401,'Credentials are never accepted in URLs');
    const response=await get(path,headers);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('vary'),/Authorization/);assert.equal((await response.json()).reports[0].id,job.id);
    const detail=await get(path+'/'+job.id,headers);assert.equal(detail.status,200);assert.equal((await detail.json()).document,'# Report');
    assert.equal((await get(path,{...headers,Origin:'https://unrelated.example'})).status,403);
    assert.equal((await fetch(login.origin+'/'+path,{method:'POST',headers})).status,405);
    assert.equal((await get('admin/ai-analysis',headers)).status,401,'A report token is not an administrator session');
    assert.equal((await get('admin/ai-analysis/tokens',{Cookie:ordinary})).status,403);
    const post=(route,cookie,csrf)=>fetch(login.origin+'/admin/ai-analysis/'+route,{method:'POST',headers:{Cookie:cookie,Origin:login.origin,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},body:JSON.stringify({name:'HTTP integration',id:'missing'})});
    assert.equal((await post('tokens',session)).status,403);assert.equal((await post('tokens/revoke',session)).status,403);
    assert.equal((await post('tokens',ordinary,f.db.session(ordinary).csrf)).status,403);
    const created=await post('tokens',session,f.db.session(session).csrf);assert.equal(created.status,201);assert.match((await created.json()).token,/^llreport_/);
    f.access.revoke(f.admin.id,{id:f.access.list(f.admin.id).find(row=>row.name==='MommyBot').id});assert.equal((await get(path,headers)).status,401);
  }finally{await new Promise(done=>server.close(done));f.db.close();}
});
