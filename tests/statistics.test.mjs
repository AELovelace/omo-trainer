import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';

function fixture(path=':memory:'){ // Synthetic identities and a fixed clock never touch live statistics or device credentials.
  let now=Date.parse('2026-09-14T06:59:59Z');const db=openDatabase(path,{statistics:{now:()=>now}});
  const admin=db.ensureParticipant('test','admin','Admin'),member=db.ensureParticipant('test','member','Private name');db.admin.bootstrap(admin.id);
  return {db,admin,member,store:db.statistics,tick:()=>{now+=1000;}};
}
function put(f,owner,entry){f.db.sync(owner,[{id:entry.id,entry,mutationId:crypto.randomUUID(),baseVersion:0}]);}
function observation(id,ml,time='2026-09-13T10:00:00-07:00'){return {id,kind:'observation',occurredAt:time,liquidsMl:ml,liquidsMode:'interval',diaperNumber:1,edited:false};}
const status=code=>error=>error.status===code;

test('statistics credentials are admin-only, scoped, live-authorized, revocable and independent of other APIs',()=>{
  const f=fixture();try{
    for(const scope of ['self','all'])assert.throws(()=>f.store.create(f.member.id,{name:'Device',scope}),status(403));
    assert.throws(()=>f.store.list(f.member.id),status(403));
    for(const input of [{name:''},{name:'x',scope:'admin'},{name:2},null])assert.throws(()=>f.store.create(f.admin.id,input),status(400));
    const own=f.store.create(f.admin.id,{name:'Limited admin display',scope:'self'}),all=f.store.create(f.admin.id,{name:'Dashboard',scope:'all'});
    assert.equal(f.store.participants(own.token).total,1);assert.equal(f.store.participants(own.token).participants[0].id,f.admin.id);
    assert.throws(()=>f.store.summary(own.token,{scope:'all'}),status(403));assert.throws(()=>f.store.summary(own.token,{scope:'participant',participantId:f.member.id}),status(403));
    assert.equal(f.store.summary(all.token,{scope:'participant',participantId:f.member.id}).participant.id,f.member.id);
    assert.equal(f.store.summary(all.token,{scope:'all'}).participant,null);
    for(const token of [undefined,'bad',all.token.replace('llstats_','llreport_'),f.db.createSession(f.admin.id)])assert.throws(()=>f.store.summary(token),status(401));
    assert.ok(f.store.list(f.admin.id).every(item=>!('token' in item)&&!('token_hash' in item)));
    f.store.revoke(f.admin.id,{id:all.id});f.store.revoke(f.admin.id,{id:all.id});assert.throws(()=>f.store.summary(all.token),status(401));
    f.db.admin.updateUser(f.admin.id,{id:f.member.id,action:'update',version:0,role:'admin',disabled:false});
    f.db.admin.updateUser(f.member.id,{id:f.admin.id,action:'update',version:1,role:'participant',disabled:false});
    assert.throws(()=>f.store.summary(own.token),status(403));assert.throws(()=>f.store.participants(own.token),status(403));
    assert.throws(()=>f.store.list(f.admin.id),status(403));
  }finally{f.db.close();}
});

test('overview and individual drilldown preserve saved-local dates, cumulative intake, categories, stars and tombstones',()=>{
  const f=fixture();try{
    const token=f.store.create(f.admin.id,{name:'Display',scope:'all'}).token;
    put(f,f.member.id,{id:'legacy',occurredAt:'2026-09-13T11:00:00-07:00',liquidsMl:500,position:'sitting',diaperNumber:1,wettingsCount:9,probability:50,result:'pee',source:'manual',edited:false});
    put(f,f.member.id,observation('early',100));put(f,f.member.id,observation('late',200,'2026-09-13T12:00:00-07:00'));
    for(const category of ['bedwetting','used-the-potty'])put(f,f.member.id,{id:category,kind:'wetting',occurredAt:'2026-09-13T14:00:00-07:00',category,position:'sitting',diaperNumber:1,wettingsCount:1,edited:false});
    put(f,f.admin.id,observation('admin-entry',40));put(f,f.member.id,observation('deleted',999));
    f.db.sync(f.member.id,[{id:'deleted',entry:null,baseVersion:1,mutationId:crypto.randomUUID()}]);
    f.db.saveGrowthChart(f.member.id,{mutationId:crypto.randomUUID(),baseVersion:0,chart:{name:'Private chart',since:'2026-09-01',refusals:0,escaped:false,rows:[{id:'custom',label:'Private row',note:'Secret note',locked:false},{id:'potty',label:'Locked',note:'',locked:true}],stars:{'2026-09-13:custom':true}}});
    const all=f.store.summary(token,{scope:'all',days:7}),one=f.store.summary(token,{scope:'participant',participantId:f.member.id,days:7});
    assert.equal(all.today,'2026-09-13');assert.equal(all.to,'2026-09-13');assert.equal(all.from,'2026-09-07');assert.equal(all.days.length,7);
    assert.equal(all.totals.liquidsMl,740);assert.equal(one.totals.liquidsMl,700);assert.equal(one.totals.observations,3);
    assert.equal(all.totals.wettings,2);assert.equal(all.totals.categories.bedwetting,1);assert.equal(all.totals.categories['used-the-potty'],1);
    assert.equal(all.totals.randomPeeResults,0);assert.equal(one.totals.chartStars,1);assert.equal(all.days.at(-1).activeParticipants,2);
    assert.equal(f.store.summary(token,{scope:'self'}).totals.chartStars,0);assert.equal(one.registeredParticipants,1);
    for(const privateText of ['Private name','Private chart','Secret note',f.member.id])assert.ok(!JSON.stringify(all).includes(privateText));
    assert.equal(one.participant.label,'Private name');assert.ok(!JSON.stringify(one).includes('Secret note'));
    f.tick();const next=f.store.summary(token,{scope:'all',days:1});assert.equal(next.to,'2026-09-14');assert.equal(next.totals.liquidsMl,0);
    assert.equal(f.store.summary(token,{scope:'all',to:'2026-09-13',days:1}).totals.liquidsMl,740);
  }finally{f.db.close();}
});

test('bounded ranges and participant pagination reject invalid dates and ambiguous scope',()=>{
  const f=fixture();try{
    const token=f.store.create(f.admin.id,{name:'Display',scope:'all'}).token;
    for(const query of [{days:0},{days:32},{days:'1.5'},{to:'2026-02-30'},{to:'2026-09-14'},{to:'bad'},{scope:'unknown'},{scope:'all',participantId:f.member.id}])assert.throws(()=>f.store.summary(token,query),status(400));
    assert.throws(()=>f.store.summary(token,{scope:'participant',participantId:'missing'}),status(404));
    for(const query of [{offset:-1},{limit:101},{offset:'Infinity'},{limit:0}])assert.throws(()=>f.store.participants(token,query),status(400));
    const first=f.store.participants(token,{limit:1}),second=f.store.participants(token,{limit:1,offset:first.nextOffset});
    assert.equal(first.total,2);assert.equal(first.nextOffset,1);assert.equal(second.nextOffset,null);assert.notEqual(first.participants[0].id,second.participants[0].id);
    assert.equal(f.store.participants(token,{offset:2}).participants.length,0);
    assert.equal(f.store.summary(token,{days:31}).days.length,31);
  }finally{f.db.close();}
});

test('statistics tokens survive reopen, store only digests and stop working when their admin is disabled',()=>{
  const directory=mkdtempSync(join(tmpdir(),'statistics-')),path=join(directory,'science.sqlite');let f=fixture(path);
  try{
    const credential=f.store.create(f.admin.id,{name:'Persistent display',scope:'all'});f.db.close();
    const raw=new DatabaseSync(path);const row=raw.prepare('SELECT * FROM statistics_tokens').get();assert.equal(row.token_hash.length,64);assert.ok(!JSON.stringify(row).includes(credential.token));raw.close();
    f=fixture(path);assert.equal(f.store.summary(credential.token,{scope:'all'}).registeredParticipants,2);
    f.db.admin.updateUser(f.admin.id,{id:f.member.id,action:'update',version:0,role:'admin',disabled:false});
    f.db.admin.updateUser(f.member.id,{id:f.admin.id,action:'update',version:1,role:'admin',disabled:true});
    assert.throws(()=>f.store.summary(credential.token),status(403));
  }finally{f.db.close();rmSync(directory,{recursive:true,force:true});}
});

test('HTTP statistics require bearer reads; admin token creation requires an admin session and CSRF',async()=>{
  const f=fixture();let actor=f.admin;const login={origin:'http://localhost',session:()=>actor?{participant:actor,csrf:'test-csrf'}:null};
  const api=createApi(f.db,login),server=createServer((req,res)=>void api(req,res,new URL(req.url,login.origin).pathname.slice(5)));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port;
  const get=(route,options={})=>fetch(base+'/api/'+route,options);
  const post=(payload,extra={})=>get('admin/statistics/tokens',{method:'POST',headers:{Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':'test-csrf',...extra},body:JSON.stringify(payload)});
  try{
    assert.equal((await post({name:'Display',scope:'all'},{'X-CSRF-Token':'wrong'})).status,403);
    actor=f.member;assert.equal((await post({name:'Display',scope:'self'})).status,403);actor=null;assert.equal((await post({name:'Display'})).status,401);actor=f.admin;
    const created=await post({name:'Display',scope:'all'});assert.equal(created.status,201);const token=(await created.json()).token,headers={Authorization:'Bearer '+token};
    const route='statistics/v1/summary?scope=all';actor=null;
    assert.equal((await get(route)).status,401);assert.equal((await get(route+'&token='+token)).status,401);
    assert.equal((await get(route,{method:'POST',headers})).status,405);assert.equal((await get(route,{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);
    const response=await get(route,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    const bytes=await response.arrayBuffer();assert.equal(bytes.byteLength,Number(response.headers.get('content-length')));assert.equal(JSON.parse(Buffer.from(bytes)).scope,'all');
    assert.equal((await get('statistics/v1/participants?limit=1',{headers})).status,200);assert.equal((await get('statistics/v1/records',{headers})).status,404);
    assert.equal((await get('ai-reports/v1/reports',{headers})).status,401);
  }finally{await new Promise(done=>server.close(done));f.db.close();}
});
