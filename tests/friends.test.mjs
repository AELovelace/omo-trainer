import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const now=Date.parse('2026-09-15T14:00:00Z');
const pref=(id,extra={})=>({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}},timeZone:'UTC',quietStart:0,quietEnd:0,communitySupport:true,...extra});
const entry=(id='one',extra={})=>({id,kind:'observation',occurredAt:'2026-09-15T14:00:00+00:00',liquidsMl:125,liquidsMode:'interval',diaperNumber:1,...extra});
const save=(db,user,value=entry(),baseVersion=0,mutationId=value?.id??'delete')=>db.sync(user.id,[{id:value?.id??'one',entry:value,baseVersion,mutationId}]);
function fixture(){let time=now;const delivered=[],db=openDatabase(':memory:',{stickerCatalog:[],now:()=>time,notifications:{random:()=>99,send:async(s,p)=>delivered.push({s,p})}});return {db,a:db.ensureParticipant('test','a','Alice'),b:db.ensureParticipant('test','b','Bob'),c:db.ensureParticipant('test','c','Cara'),delivered,setTime:t=>time=t};}
function friend(db,a,b){const row=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:row.id});return row;}
const share=(db,a,b,recordId='one',version=1)=>db.friends.share(a.id,{participantId:b.id,recordId,version});
function disable(db,a,b){db.admin.bootstrap(a.id);const row=db.admin.users(a.id).find(u=>u.id===b.id);db.admin.updateUser(a.id,{action:'update',id:b.id,role:'participant',disabled:true,version:row.version});}

test('bounded display-name search exposes only public labels and request status; requests require recipient acceptance',()=>{
 const {db,a,b,c}=fixture();try {
  assert.deepEqual(db.friends.search(a.id,'Bo').map(u=>u.label),['Bob']);
  assert.equal(JSON.stringify(db.friends.search(a.id,'Bo')).includes('issuer'),false);
  assert.throws(()=>db.friends.search(a.id,''),e=>e.status===400);assert.equal(db.friends.search(a.id,'%%').length,0);
  assert.equal(db.friends.search(a.id,'Alice').length,0);assert.throws(()=>db.friends.act(a.id,{action:'request',participantId:a.id}));
  const request=db.friends.act(a.id,{action:'request',participantId:b.id});
  assert.equal(db.friends.act(a.id,{action:'request',participantId:b.id}).id,request.id,'Retry reuses a pending request');
  assert.equal(db.friends.act(b.id,{action:'request',participantId:a.id}).state,'pending','Crossed requests still require acceptance');
  assert.throws(()=>db.friends.act(a.id,{action:'accept',id:request.id}),e=>e.status===403);
  assert.throws(()=>db.friends.act(c.id,{action:'accept',id:request.id}),e=>e.status===404);
  assert.throws(()=>db.friends.act(c.id,{action:'remove',id:request.id}),e=>e.status===404);
  assert.equal(db.friends.list(b.id)[0].direction,'incoming');db.friends.act(b.id,{action:'accept',id:request.id});assert.equal(db.friends.accepted(a.id,b.id),true);
  db.friends.act(a.id,{action:'remove',id:request.id});assert.equal(db.friends.list(b.id).length,0);
  const next=db.friends.act(a.id,{action:'request',participantId:b.id});assert.notEqual(next.id,request.id);db.friends.act(b.id,{action:'remove',id:next.id});assert.equal(db.friends.list(a.id).length,0);
  disable(db,a,b);assert.equal(db.friends.search(a.id,'Bo').length,0);assert.throws(()=>db.friends.act(a.id,{action:'request',participantId:b.id}),e=>e.status===404);
 }finally{db.close();}
});

test('only an owner can share a current preview with accepted friends; grants are individual and read-only',()=>{
 const {db,a,b,c}=fixture();try {
  save(db,a);save(db,a,entry('private'));assert.throws(()=>share(db,a,b),e=>e.status===403);
  const pending=db.friends.act(a.id,{action:'request',participantId:b.id});assert.throws(()=>share(db,a,b),e=>e.status===403);
  db.friends.act(b.id,{action:'accept',id:pending.id});friend(db,b,c);
  assert.throws(()=>db.friends.record(b.id,'one'),e=>e.status===404);assert.throws(()=>share(db,b,c),e=>e.status===404);
  assert.throws(()=>share(db,a,b,'one',0),e=>e.status===409);
  const grant=share(db,a,b);assert.equal(share(db,a,b).id,grant.id);
  const received=db.friends.shared(b.id).items;assert.equal(received.length,1);assert.equal(received[0].record.entry.liquidsMl,125);assert.equal(received[0].friend.label,'Alice');
  assert.equal(db.friends.shared(c.id).items.length,0);assert.equal(db.records(b.id).length,0,'Shared records are not imported into the recipient timeline');
  assert.equal(db.friends.shared(a.id,{direction:'outgoing'}).items.length,1);
  db.friends.unshare(b.id,grant.id);assert.equal(db.friends.shared(b.id).items.length,1,'Only the owner revokes this grant');
  save(db,a,entry('one',{liquidsMl:250}),1,'edit');assert.equal(db.friends.shared(b.id).items[0].record.entry.liquidsMl,250);
  db.friends.unshare(a.id,grant.id);assert.equal(db.friends.shared(b.id).items.length,0);
 }finally{db.close();}
});

test('removal, source deletion and disabled accounts revoke visibility; restoration or re-friending never revives shares',()=>{
 const {db,a,b}=fixture();try {
  let link=friend(db,a,b);save(db,a);share(db,a,b);save(db,a,null,1,'deleted');assert.equal(db.friends.shared(b.id).items.length,0);
  save(db,a,entry(),2,'restored');assert.equal(db.friends.shared(b.id).items.length,0);
  share(db,a,b,'one',3);db.friends.act(b.id,{action:'remove',id:link.id});link=friend(db,a,b);assert.equal(db.friends.shared(b.id).items.length,0);
  share(db,a,b,'one',3);disable(db,a,b);assert.equal(db.friends.shared(a.id,{direction:'outgoing'}).items.length,0);assert.throws(()=>db.friends.shared(b.id),e=>e.status===403);
  assert.equal(db.friends.accepted(a.id,b.id),false);
 }finally{db.close();}
});

test('shared-record paging is bounded and friendship data persists across restart',()=>{
 const dir=mkdtempSync(resolve('artifacts/friends-persistence-')),file=resolve(dir,'science.sqlite');let db=openDatabase(file,{stickerCatalog:[]});
 try {
  const a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');friend(db,a,b);
  for(let i=0;i<52;i++){save(db,a,entry('e'+i));share(db,a,b,'e'+i);}
  const page=db.friends.shared(b.id);assert.equal(page.items.length,50);assert.equal(page.nextOffset,50);assert.equal(db.friends.shared(b.id,{offset:50}).items.length,2);
  assert.throws(()=>db.friends.shared(b.id,{direction:'all'}));assert.throws(()=>db.friends.shared(b.id,{offset:-1}));
  db.close();db=openDatabase(file,{stickerCatalog:[]});assert.equal(db.friends.list(a.id)[0].state,'accepted');assert.equal(db.friends.shared(b.id).items.length,50);
 }finally{db.close();}
});

test('friends-only community support filters both directions and preserves anonymity',async()=>{
 for(const mode of ['sender','recipient']){
  const {db,a,b,c,delivered}=fixture();try {
   friend(db,a,b);
   db.notifications.save(a.id,pref('a',{communityFriendsOnly:mode==='sender',communityAnonymous:true}));
   db.notifications.save(b.id,pref('b',{communityFriendsOnly:mode==='recipient'}));
   db.notifications.save(c.id,pref('c',{communityFriendsOnly:mode==='recipient'}));
   save(db,a);await db.notifications.tick(now);assert.equal(delivered.length,1);assert.ok(delivered[0].s.endpoint.endsWith('/b'));assert.equal(delivered[0].p.displayName,undefined);
  }finally{db.close();}
 }
});

test('restricting pending notifications or removing a friend cancels the old audience permanently',async()=>{
 for(const mode of ['restrict-sender','restrict-recipient','remove']){
  const {db,a,b,delivered}=fixture();try {
   let link;if(mode==='remove')link=friend(db,a,b);
   db.notifications.save(a.id,pref('a',{communityFriendsOnly:mode==='remove'}));db.notifications.save(b.id,pref('b',{quietStart:13,quietEnd:16}));save(db,a);await db.notifications.tick(now);assert.equal(delivered.length,0);
   if(mode==='remove'){db.friends.act(a.id,{action:'remove',id:link.id});friend(db,a,b);}
   else {const user=mode==='restrict-sender'?a:b,id=mode==='restrict-sender'?'a':'b';db.notifications.save(user.id,pref(id,{communityFriendsOnly:true}));db.notifications.save(user.id,pref(id,{communityFriendsOnly:false}));}
   await db.notifications.tick(now+7200000);assert.equal(delivered.length,0,mode);
  }finally{db.close();}
 }
 const {db,a}=fixture();try{assert.equal(db.notifications.save(a.id,pref('a')).preferences.communityFriendsOnly,0);db.notifications.save(a.id,pref('a',{communityFriendsOnly:true}));assert.equal(db.notifications.save(a.id,pref('other-device')).preferences.communityFriendsOnly,1);for(const value of [1,null,'true'])assert.throws(()=>db.notifications.save(a.id,pref('a',{communityFriendsOnly:value})));}finally{db.close();}
});

test('friends HTTP API is session-owned, CSRF protected and uncached, with no foreign-record endpoint',async()=>{
 const {db,a,b,c}=fixture();friend(db,a,b);save(db,a);const tokens=new Map([a,b,c].map(u=>[u.id,db.createSession(u.id)]));
 const login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 const get=(user,path)=>fetch(login.origin+'/'+path,{headers:user?{Cookie:tokens.get(user.id)}:{}});
 const post=(user,path,input,headers={})=>fetch(login.origin+'/'+path,{method:'POST',headers:{Cookie:tokens.get(user.id),Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':db.session(tokens.get(user.id)).csrf,...headers},body:JSON.stringify(input)});
 try {
  assert.equal((await get(null,'friends/search?q=Bob')).status,401);
  const list=await get(a,'friends');assert.equal(list.headers.get('cache-control'),'no-store');assert.equal((await list.json()).friends.length,1);
  const input={participantId:b.id,recordId:'one',version:1};assert.equal((await post(a,'friends/share',input,{'X-CSRF-Token':'wrong'})).status,403);assert.equal((await post(a,'friends/share',input,{Origin:'https://evil.example'})).status,403);
  assert.equal((await post(c,'friends/share',{...input,owner:a.id})).status,403);assert.equal((await post(a,'friends/share',input)).status,200);
  assert.equal((await get(b,'friends/record?id=one&participantId='+a.id)).status,404);
  const received=await get(b,'friends/shared');assert.equal(received.headers.get('cache-control'),'no-store');assert.equal((await received.json()).items.length,1);
  assert.equal((await get(c,'friends/shared?participantId='+b.id)).status,200);assert.equal((await (await get(c,'friends/shared')).json()).items.length,0);
 }finally{await new Promise(r=>server.close(r));db.close();}
});
