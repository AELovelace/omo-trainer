import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';
import { datasetCsv,parseCsv } from '../lib/admin-format.js';
import { parseAdminImport } from '../server/admin-transfer.mjs';
import { analyzeDataset } from '../lib/admin-analytics.js';

const observation=(id='entry',liquidsMl=100)=>({id,kind:'observation',occurredAt:'2026-09-11T10:00:00+00:00',liquidsMl,liquidsMode:'interval',diaperNumber:1,edited:false});
const chart=()=>({name:'=Test, "visitor"',since:'2026-09-01',refusals:3,escaped:true,rows:[
  {id:'custom',label:'=Custom line',note:"A note, with\nquotes \"and\" apostrophes",locked:false},
  {id:'potty',label:'Locked',note:'',locked:true}],stars:{'2026-09-11:custom':true}});
function fixture() {
  const db=openDatabase(':memory:');
  const admin=db.ensureParticipant('issuer','admin-sub','lid0ll'),alice=db.ensureParticipant('issuer','alice-sub','Alice');
  db.admin.bootstrap(admin.id);
  return {db,admin,alice};
}
const backup=(user,entry,chartValue=null)=>({format:'little-log-admin',schemaVersion:1,users:[{id:user.id,label:user.label,records:entry?[{id:entry.id,version:1,entry}]:[],growthChart:{chart:chartValue}}]});
const input=(data,extra={})=>({format:'json',text:JSON.stringify(data),mode:'merge',...extra});

test('admin binding uses stable identity; live role checks and last-admin protection survive label changes and session revocation',()=>{
  const {db,admin,alice}=fixture();
  try {
    const impostor=db.ensureParticipant('another-issuer','someone','lid0ll');
    assert.throws(()=>db.admin.users(impostor.id),error=>error.status===403);
    assert.equal(db.admin.access(impostor.id).role,'participant');
    assert.throws(()=>db.admin.bootstrap(impostor.id),error=>error.status===409);
    db.ensureParticipant('issuer','admin-sub','Renamed');
    const token=db.createSession(admin.id);
    assert.equal(db.session(token).role,'admin');
    assert.throws(()=>db.admin.updateUser(admin.id,{id:admin.id,action:'update',version:1,role:'participant',disabled:false}),error=>error.status===409);
    const aliceToken=db.createSession(alice.id);
    db.admin.updateUser(admin.id,{id:alice.id,action:'update',version:0,role:'participant',disabled:true});
    assert.equal(db.session(aliceToken),null);
    assert.throws(()=>db.createSession(alice.id),error=>error.status===403);
    assert.throws(()=>db.admin.updateUser(admin.id,{id:alice.id,action:'update',version:0,role:'admin',disabled:false}),error=>error.status===409);
    db.admin.updateUser(admin.id,{id:alice.id,action:'update',version:1,role:'admin',disabled:false});
    db.admin.updateUser(alice.id,{id:admin.id,action:'update',version:1,role:'participant',disabled:false});
    assert.equal(db.session(token),null);
    assert.throws(()=>db.admin.dataset(admin.id),error=>error.status===403);
    assert.ok(db.admin.auditList(alice.id).length>=4);
  }finally{db.close();}
});

test('JSON and CSV import/export preserve participant-owned entries, formulas, multiline row meanings and complete charts',()=>{
  const {db,admin,alice}=fixture();
  try {
    const transfer=input(backup(alice,observation(),chart()));
    const preview=db.admin.previewImport(admin.id,transfer);
    assert.equal(preview.summary.added,1);
    assert.equal(db.records(alice.id).length,0,'Preview must not write records');
    db.admin.importData(admin.id,{...transfer,token:preview.token});
    const exported=db.admin.dataset(admin.id,alice.id);
    assert.deepEqual(exported.users[0].growthChart.chart,chart());
    const csv=datasetCsv(exported),parsed=parseAdminImport({format:'csv',text:csv,mode:'merge'});
    assert.deepEqual(parsed[0].chart,chart());
    assert.deepEqual(parsed[0].records,[observation()]);
    assert.ok(csv.includes("'=Test"));
    for(const format of ['json','csv']) {
      const same={format,text:format==='json'?JSON.stringify(exported):csv,mode:'merge'};
      const review=db.admin.previewImport(admin.id,same);
      assert.equal(review.summary.unchanged,2);
      db.admin.importData(admin.id,{...same,token:review.token});
      assert.equal(db.records(alice.id)[0].version,1,'Identical imports do not generate extra versions');
    }
    assert.throws(()=>db.admin.previewImport(admin.id,{...transfer,participantId:admin.id}),/different participant/);
    assert.equal(db.admin.access(alice.id).role,'participant','Importing a participant cannot elevate their role');
    assert.deepEqual(parseCsv('a,b\r\n"x,y","two\nlines"'),[{a:'x,y',b:'two\nlines'}]);
    assert.throws(()=>parseCsv('a,b\n"unfinished,b'),/unclosed/);
  }finally{db.close();}
});

test('imports are atomic, stale previews are rejected and explicit replacements advance versions seen by participant sync',()=>{
  const {db,admin,alice}=fixture();
  try {
    const initial=input(backup(alice,observation()));
    db.admin.importData(admin.id,{...initial,token:db.admin.previewImport(admin.id,initial).token});
    const replace=input(backup(alice,observation('entry',200)),{mode:'replace'});
    const preview=db.admin.previewImport(admin.id,replace);
    db.sync(alice.id,[{id:'entry',mutationId:'concurrent',baseVersion:1,entry:observation('entry',300)}]);
    assert.throws(()=>db.admin.importData(admin.id,{...replace,token:preview.token}),error=>error.status===409);
    const merge=input({...backup(alice,observation('entry',200)),users:[{...backup(alice,observation('entry',200)).users[0],records:[{entry:observation('entry',200)},{entry:observation('new-entry')}]}]});
    const review=db.admin.previewImport(admin.id,merge);
    assert.equal(review.summary.conflicts,1);
    assert.throws(()=>db.admin.importData(admin.id,{...merge,token:review.token}),error=>error.status===409);
    assert.equal(db.records(alice.id).length,1);
    db.admin.importData(admin.id,{...replace,token:db.admin.previewImport(admin.id,replace).token});
    assert.equal(db.records(alice.id)[0].version,3);
    assert.equal(db.sync(alice.id,[{id:'entry',mutationId:'old-device',baseVersion:2,entry:observation()}]).conflicts.length,1);
    db.sync(alice.id,[{id:'entry',mutationId:'delete',baseVersion:3,entry:null}]);
    assert.equal(db.admin.previewImport(admin.id,initial).summary.conflicts,1,'Merge cannot resurrect deleted entries');
    const unknown=input(backup({id:'unknown',label:'Unknown'},observation()));
    assert.throws(()=>db.admin.previewImport(admin.id,unknown),/Unknown participant/);
  }finally{db.close();}
});

test('admin API requires authorization before reading or parsing data, CSRF for changes, and no-store responses',async()=>{
  const {db,admin,alice}=fixture(),token=db.createSession(admin.id),ordinary=db.createSession(alice.id);
  const login={origin:'',session:request=>db.session(request.headers.cookie)};
  const api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));login.origin='http://127.0.0.1:'+server.address().port;
  const get=(route,cookie)=>fetch(login.origin+'/'+route,{headers:cookie?{Cookie:cookie}:{}});
  try {
    assert.equal((await get('admin/users')).status,401);
    for(const route of ['admin/users','admin/data','admin/audit']) assert.equal((await get(route,ordinary)).status,403);
    const response=await get('admin/users',token);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.status,200);
    const {csrf}=await response.json();
    const post=headers=>fetch(login.origin+'/admin/user',{method:'POST',headers:{Cookie:token,'Content-Type':'application/json',...headers},body:JSON.stringify({id:alice.id,action:'revoke',version:0})});
    assert.equal((await post({Origin:login.origin})).status,403);
    assert.equal((await post({Origin:'https://wrong.example','X-CSRF-Token':csrf})).status,403);
    assert.equal((await post({Origin:login.origin,'X-CSRF-Token':csrf})).status,200);
    assert.equal(db.session(ordinary),null);
  }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});

test('analytics separate participant-day intake, actual events, random draws and user-defined chart rows',()=>{
  const legacy={id:'old',occurredAt:'2026-09-11T09:00:00+00:00',liquidsMl:500,position:'sitting',diaperNumber:1,wettingsCount:9,probability:50,result:'pee',source:'manual',edited:false};
  const wetting={id:'wet',kind:'wetting',occurredAt:'2026-09-11T12:00:00+00:00',category:'semi-forced',position:'sitting',diaperNumber:1,wettingsCount:10,edited:false};
  const roll={id:'roll',kind:'roll',occurredAt:'2026-09-11T11:00:00+00:00',rolledAt:'2026-09-11T11:00:00+00:00',rolledResult:'hold',probability:50,result:'hold',source:'random'};
  const data={users:[
    {id:'alice',label:'Shared name',records:[legacy,observation(),wetting,roll].map(entry=>({entry})),growthChart:{chart:chart()}},
    {id:'bob',label:'Shared name',records:[observation('bob',200)].map(entry=>({entry})),growthChart:{chart:{...chart(),rows:[{...chart().rows[0],label:'Different line'},chart().rows[1]]}}}
  ]};
  const view=analyzeDataset(data,{from:'2026-09-11',to:'2026-09-11'});
  assert.equal(view.totals.liquids,800,'Cumulative plus later intervals are evaluated per participant-day');
  assert.equal(view.totals.wettings,1,'Reported cumulative wetting counts must not become events');
  assert.equal(view.totals.randomRolls,1,'Manual snapshots must not enter random-draw rates');
  assert.equal(view.graphs.find(g=>g.id==='classification').rows.find(row=>row[0]==='semi-forced')[1],1);
  assert.equal(view.chartRows.filter(row=>row[2]==='custom').length,2);
  assert.equal(new Set(view.chartRows.filter(row=>row[2]==='custom').map(row=>row[3])).size,2);
  assert.equal(view.graphs.length,23);
  assert.equal(analyzeDataset(data,{from:'2026-09-12'}).totals.wettings,0);
});

test('legacy individual CSV without IDs has repeatable import identity and preserves cumulative semantics',()=>{
  const text='occurredAt,liquidsMl,position,diaperNumber,wettingsCount,probability,result,source,edited,kind,liquidsMode\n2026-09-11T10:00:00+00:00,400,sitting,1,3,50,pee,manual,false,roll,cumulative';
  const value=parseAdminImport({format:'csv',text,participantId:'alice'})[0].records[0];
  assert.equal(value.kind,undefined);
  assert.equal(value.liquidsMl,400);
  assert.equal(parseAdminImport({format:'csv',text,participantId:'alice'})[0].records[0].id,value.id);
  assert.throws(()=>parseAdminImport({format:'csv',text}),/Select a user/);
});
