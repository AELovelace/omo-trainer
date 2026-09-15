import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const wet=(id,category='involuntary')=>({id,kind:'wetting',occurredAt:'2026-09-15T12:00:00-07:00',category,position:'sitting',diaperNumber:7});
const change=(entry,baseVersion=0,mutationId=entry.id+'-'+baseVersion)=>({id:entry.id,mutationId,baseVersion,entry});
function fixture(file=':memory:'){
 const db=openDatabase(file),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob'),c=db.ensureParticipant('test','c','Cara');
 if(!db.friends.accepted(a.id,b.id)){const f=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:f.id});}
 const prefs=(enabled,audience='friends')=>db.social.saveRecordPreferences(a.id,{enabled,audience,version:db.social.recordPreferences(a.id).version});
 return {db,a,b,c,prefs};
} // Fixtures exercise the same atomic sync path used by phones, rather than calling the publishing hook directly.
test('record sharing starts off, publishes only new eligible records, and retries do not duplicate',()=>{
 const {db,a,b,c,prefs}=fixture();try{
  assert.deepEqual(db.social.recordPreferences(a.id),{enabled:false,audience:'friends',version:0});db.sync(a.id,[change(wet('before'))]);assert.equal(db.social.feed(a.id).items.length,0);
  prefs(true);assert.equal(db.social.feed(a.id).items.length,0);db.sync(a.id,[change(wet('before','used-the-potty'),1)]);assert.equal(db.social.feed(a.id).items.length,0);
  const batch=[change(wet('accident')),change(wet('potty','used-the-potty')),change(wet('bed','bedwetting')),change({id:'change',kind:'diaper-change',occurredAt:'2026-09-15T12:10:00-07:00',diaperNumber:7,wettingsCount:3}),change({id:'liquids',kind:'observation',occurredAt:'2026-09-15T12:00:00-07:00',liquidsMl:200,liquidsMode:'interval',diaperNumber:7}),change({id:'roll',kind:'roll',occurredAt:'2026-09-15T12:00:00-07:00',rolledAt:'2026-09-15T12:00:00-07:00',rolledResult:'pee',result:'pee',source:'random',probability:50})];
  db.sync(a.id,batch);db.sync(a.id,batch);const posts=db.social.feed(b.id).items;assert.equal(posts.length,4);assert.equal(db.social.feed(c.id,{audience:'public'}).items.length,0);assert.match(posts.map(p=>p.body).join('\n'),/Involuntary accident/);assert.match(posts.map(p=>p.body).join('\n'),/Used the potty/);assert.match(posts.map(p=>p.body).join('\n'),/3 wettings/);assert.ok(posts.every(p=>!p.body.includes('sitting')&&!p.body.includes('diaperNumber')&&p.audience==='friends'));
  for(const p of posts)assert.throws(()=>db.social.post(c.id,p.id),e=>e.status===404);assert.equal(db.activity.list(b.id).items.filter(i=>i.kind==='friend-post').length,4);
 }finally{db.close();}
});
test('audience and opt-out affect future posts; edits preserve audience, deletes withdraw and cannot resurrect',()=>{
 const {db,a,b,c,prefs}=fixture();try{
  prefs(true);db.sync(a.id,[change(wet('private'))]);const first=db.social.feed(a.id).items[0];prefs(true,'public');db.sync(a.id,[change(wet('public'))]);const second=db.social.feed(c.id,{audience:'public'}).items[0];assert.ok(second);assert.throws(()=>db.social.post(c.id,first.id),e=>e.status===404);
  prefs(false,'public');db.sync(a.id,[change(wet('off')),change(wet('private','bedwetting'),1)]);assert.equal(db.social.feed(a.id).items.length,2);assert.match(db.social.post(b.id,first.id).body,/Bedwetting/);assert.equal(db.social.post(a.id,first.id).audience,'friends');
  db.social.comment(b.id,{requestId:'comment',postId:first.id,body:'Support'});db.sync(a.id,[{id:'private',mutationId:'delete',baseVersion:2,entry:null}]);assert.throws(()=>db.social.post(b.id,first.id),e=>e.status===404);assert.ok(!db.activity.list(b.id).items.some(n=>n.postId===first.id));
  prefs(true);db.sync(a.id,[change(wet('private'),3)]);assert.throws(()=>db.social.post(a.id,first.id),e=>e.status===404);
  db.social.deletePost(a.id,second.id);db.sync(a.id,[change(wet('public','voluntary'),1)]);assert.equal(db.social.feed(a.id).items.length,0);
 }finally{db.close();}
});
test('conflicts and failed batches never publish; social restrictions do not block recording',()=>{
 const {db,a,b,prefs}=fixture();try{
  prefs(true);db.sync(a.id,[change(wet('saved'))]);const original=db.social.feed(a.id).items[0];assert.equal(db.sync(a.id,[change(wet('saved','bedwetting'),0,'conflict')]).conflicts.length,1);assert.equal(db.social.post(a.id,original.id).body.includes('Bedwetting'),false);
  assert.throws(()=>db.sync(a.id,[change(wet('rollback')),change(wet('saved','bedwetting'),0,'saved-0')]));assert.equal(db.social.feed(a.id).items.length,1);assert.ok(!db.records(a.id).some(r=>r.id==='rollback'));
  db.admin.bootstrap(b.id);db.social.moderate(b.id,{action:'restrict',participantId:a.id,reason:'Test restriction'});db.sync(a.id,[change(wet('restricted'))]);assert.ok(db.records(a.id).some(r=>r.id==='restricted'));assert.equal(db.social.feed(a.id).items.length,1);
  db.social.moderate(b.id,{action:'remove',kind:'post',id:original.id,reason:'Remove test post'});db.sync(a.id,[change(wet('saved','bedwetting'),1)]);assert.equal(db.social.feed(a.id).items.length,0);
 }finally{db.close();}
});
test('preferences persist with optimistic updates; existing accounts never gain opt-in on upgrade',()=>{
 const file=resolve(mkdtempSync(resolve('artifacts/record-sharing-')),'test.sqlite');let {db,a,b,prefs}=fixture(file);try{
  prefs(true,'public');assert.throws(()=>db.social.saveRecordPreferences(a.id,{enabled:false,audience:'friends',version:0}),e=>e.status===409);
  for(const input of [{enabled:1,audience:'friends',version:1},{enabled:true,audience:'private',version:1},{enabled:true,audience:'public',version:-1}])assert.throws(()=>db.social.saveRecordPreferences(a.id,input),e=>e.status===400);
  db.sync(a.id,[change(wet('persistent'))]);db.close();db=openDatabase(file);assert.equal(db.social.recordPreferences(a.id).enabled,true);assert.equal(db.social.recordPreferences(b.id).enabled,false);db.sync(a.id,[change(wet('persistent'))]);assert.equal(db.social.feed(a.id).items.length,1);
 }finally{db.close();}
});
test('admin imports correct existing summaries without posting historical records',()=>{
 const {db,a,b,prefs}=fixture();try{
  prefs(true);db.sync(a.id,[change(wet('original'))]);db.admin.bootstrap(b.id);
  const entries=[wet('original','used-the-potty'),wet('historical')],input={format:'json',mode:'replace',text:JSON.stringify({format:'little-log-admin',schemaVersion:1,users:[{id:a.id,label:a.label,records:entries.map(entry=>({id:entry.id,version:1,entry})),growthChart:{chart:null}}]})};
  const review=db.admin.previewImport(b.id,input);db.admin.importData(b.id,{...input,token:review.token});assert.equal(db.social.feed(a.id).items.length,1);assert.match(db.social.feed(a.id).items[0].body,/Used the potty/);
 }finally{db.close();}
});
test('record settings HTTP API requires session and CSRF and never accepts a supplied owner',async()=>{
 const {db,a,b}=fixture(),tokens=new Map([a,b].map(u=>[u.id,db.createSession(u.id)])),login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login);
 const server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 const url=login.origin+'/social/record-settings',headers={Cookie:tokens.get(a.id),Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':db.session(tokens.get(a.id)).csrf};
 try{
  assert.equal((await fetch(url)).status,401);const response=await fetch(url,{headers});assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).enabled,false);
  const body=JSON.stringify({enabled:true,audience:'public',version:0,owner:b.id});assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-CSRF-Token':'bad'},body})).status,403);assert.equal((await fetch(url,{method:'POST',headers,body})).status,200);assert.equal(db.social.recordPreferences(a.id).enabled,true);assert.equal(db.social.recordPreferences(b.id).enabled,false);
  db.admin.bootstrap(b.id);const user=db.admin.users(b.id).find(u=>u.id===a.id);db.admin.updateUser(b.id,{action:'update',id:a.id,role:'participant',disabled:true,version:user.version});assert.ok([401,403].includes((await fetch(url,{headers})).status));
 }finally{await new Promise(r=>server.close(r));db.close();}
});
