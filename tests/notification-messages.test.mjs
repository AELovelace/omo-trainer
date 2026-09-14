import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const now=Date.parse('2026-09-15T14:00:00Z');
const subscription=id=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}});
const preference=(id,extra={})=>({subscription:subscription(id),timeZone:'UTC',quietStart:0,quietEnd:0,adminMessages:true,...extra});
const message=(id,participantId='')=>({requestId:id,title:'Little Log',body:'Hello <img src=x onerror=alert(1)>!',participantId});
function fixture(send=async()=>{}){const db=openDatabase(':memory:',{stickerCatalog:[],notifications:{publicKey:'public',send,random:()=>99}});const admin=db.ensureParticipant('test','admin','Admin'),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');db.admin.bootstrap(admin.id);return {db,admin,a,b};}
function access(db,admin,user,role,disabled=false){const row=db.admin.users(admin.id).find(row=>row.id===user.id);db.admin.updateUser(admin.id,{action:'update',id:user.id,role,disabled,version:row.version});}

test('admin message permissions, explicit opt-in migration, validation and idempotent queueing',()=>{
 const {db,admin,a}=fixture();try{
  db.notifications.save(a.id,{...preference('old'),adminMessages:undefined});
  assert.equal(db.notifications.status(a.id).preferences.adminMessages,0);
  assert.equal(db.notifications.messages.overview(admin.id).recipients.length,0);
  assert.throws(()=>db.notifications.messages.queue(admin.id,message('no-recipients'),now),e=>e.status===400);
  assert.throws(()=>db.notifications.messages.overview(a.id),e=>e.status===403);
  db.notifications.save(a.id,preference('old'));
  for(const input of [null,[],{...message('invalid-1'),title:''},{...message('invalid-2'),body:'a'.repeat(501)},{...message('invalid-3'),requestId:'x'},{...message('invalid-4'),participantId:4}])assert.throws(()=>db.notifications.messages.queue(admin.id,input,now),e=>e.status===400);
  assert.throws(()=>db.notifications.messages.queue(a.id,message('not-an-admin'),now),e=>e.status===403);
  const first=db.notifications.messages.queue(admin.id,message('same-request',a.id),now);
  const second=db.notifications.messages.queue(admin.id,message('same-request',a.id),now);assert.equal(first.id,second.id);assert.equal(second.repeated,true);
  assert.throws(()=>db.notifications.messages.queue(admin.id,{...message('same-request',a.id),body:'Changed'},now),e=>e.status===409);
  assert.equal(db.notifications.messages.overview(admin.id).messages.length,1);
  assert.equal(db.admin.auditList(admin.id).filter(row=>row.action==='queue-notification').length,1);
 }finally{db.close();}
});

test('individual and broadcast delivery use a recipient snapshot, exclude disabled users, and cannot duplicate',async()=>{
 const delivered=[];const {db,admin,a,b}=fixture(async(sub,payload)=>delivered.push({sub,payload}));try{
  db.notifications.save(a.id,preference('alice-1'));db.notifications.save(a.id,preference('alice-2'));db.notifications.save(b.id,preference('bob'));
  const solo=db.notifications.messages.queue(admin.id,message('individual-1',a.id),now);
  await Promise.all([db.notifications.tick(now),db.notifications.tick(now)]);await db.notifications.tick(now);
  assert.equal(delivered.length,2);assert.ok(delivered.every(row=>row.sub.endpoint.includes('alice')));assert.equal(delivered[0].payload.kind,'admin-message');assert.equal(delivered[0].payload.body,message('x').body);
  assert.equal(JSON.stringify(delivered.map(row=>row.payload)).includes(a.id),false);
  assert.equal(db.notifications.messages.overview(admin.id).messages.find(row=>row.id===solo.id).accepted,2);
  access(db,admin,b,'participant',true);
  const broadcast=db.notifications.messages.queue(admin.id,message('broadcast-1'),now);
  const late=db.ensureParticipant('test','late','Late');db.notifications.save(late.id,preference('late'));
  await db.notifications.tick(now);assert.equal(delivered.length,4);
  const overview=db.notifications.messages.overview(admin.id);assert.equal(overview.messages.find(row=>row.id===broadcast.id).members,1);
  assert.equal(JSON.stringify(overview).includes('fcm.googleapis.com'),false);assert.equal(JSON.stringify(overview).includes('p256dh'),false);
 }finally{db.close();}
});

test('quiet hours defer delivery; opt-out, cancellation, expiry and revoked administrator prevent pending sends',async()=>{
 const delivered=[];const {db,admin,a,b}=fixture(async(s,p)=>delivered.push(p));try{
  db.notifications.save(a.id,preference('a',{quietStart:13,quietEnd:16}));
  const quiet=db.notifications.messages.queue(admin.id,message('quiet-hours'),now);await db.notifications.tick(now);assert.equal(delivered.length,0);
  await db.notifications.tick(now+2*3600000);assert.equal(delivered.length,1);
  assert.equal(db.notifications.messages.overview(admin.id).messages.find(row=>row.id===quiet.id).queued,0);
  const cancelled=db.notifications.messages.queue(admin.id,message('cancel-message'),now);assert.throws(()=>db.notifications.messages.cancel(a.id,{id:cancelled.id}),e=>e.status===403);
  db.notifications.messages.cancel(admin.id,{id:cancelled.id});await db.notifications.tick(now+2*3600000);assert.equal(delivered.length,1);
  db.notifications.messages.queue(admin.id,message('opt-out-msg'),now);db.notifications.save(a.id,preference('a',{adminMessages:false}));db.notifications.save(a.id,preference('a'));await db.notifications.tick(now);assert.equal(delivered.length,1);
  db.notifications.messages.queue(admin.id,message('all-off-msg'),now);db.notifications.remove(a.id,{all:true});db.notifications.save(a.id,preference('a'));await db.notifications.tick(now);assert.equal(delivered.length,1);
  db.notifications.messages.queue(admin.id,message('expire-msg'),now);await db.notifications.tick(now+86400000);assert.equal(delivered.length,1);
  db.notifications.messages.queue(admin.id,message('revoke-admin'),now);access(db,admin,b,'admin');access(db,b,admin,'participant');await db.notifications.tick(now);assert.equal(delivered.length,1);
  assert.equal(db.notifications.messages.overview(b.id).messages.filter(row=>row.queued).length,0);
 }finally{db.close();}
});

test('pending announcements survive restart and transport failures are recorded without replay',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'little-log-push-test-')),file=path.join(directory,'tracker.sqlite');let db;const delivered=[];
 try{
  const options={stickerCatalog:[],notifications:{send:async(s,p)=>{delivered.push(p);throw {statusCode:410};},random:()=>99}};
  db=openDatabase(file,options);const admin=db.ensureParticipant('test','admin','Admin'),user=db.ensureParticipant('test','user','User');db.admin.bootstrap(admin.id);db.notifications.save(user.id,preference('gone'));db.notifications.messages.queue(admin.id,message('persist-queue'),now);db.close();
  db=openDatabase(file,options);await db.notifications.tick(now);assert.equal(delivered.length,1);assert.equal(db.notifications.messages.overview(admin.id).messages[0].failed,1);assert.equal(db.notifications.status(user.id).subscriptions,0);db.close();
  db=openDatabase(file,options);await db.notifications.tick(now+60000);assert.equal(delivered.length,1);
 }finally{db?.close();if(path.dirname(directory)!==path.resolve(tmpdir())||!path.basename(directory).startsWith('little-log-push-test-'))throw Error('Unsafe fixture cleanup.');rmSync(directory,{recursive:true,force:true});}
});

test('announcement API requires a live admin, same-origin CSRF, private responses and valid payloads',async()=>{
 const {db,admin,a}=fixture();db.notifications.save(a.id,preference('a'));const adminToken=db.createSession(admin.id),userToken=db.createSession(a.id),login={origin:'',session:req=>db.session(req.headers.cookie)};
 const api=createApi(db,login),server=createServer((req,res)=>api(req,res,req.url.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(login.origin+'/admin/notifications')).status,401);assert.equal((await fetch(login.origin+'/admin/notifications',{headers:{Cookie:userToken}})).status,403);
  const response=await fetch(login.origin+'/admin/notifications',{headers:{Cookie:adminToken}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const csrf=db.session(adminToken).csrf;
  const post=(route,headers={},body=message('api-message'))=>fetch(login.origin+'/admin/'+route,{method:'POST',headers:{Cookie:adminToken,Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},body:JSON.stringify(body)});
  assert.equal((await post('notifications',{'X-CSRF-Token':'wrong'})).status,403);assert.equal((await post('notifications',{Origin:'https://evil.example'})).status,403);
  const sent=await post('notifications');assert.equal(sent.status,200);const result=await sent.json();assert.equal((await post('notifications/cancel',{}, {id:result.id})).status,200);
 }finally{await new Promise(r=>server.close(r));db.close();}
});

test('service worker displays authored admin text literally, rejects oversized payloads and ignores external click destinations',async()=>{
 const handlers={},shown=[];let opened;
 const self={registration:{scope:'https://lidoll.dev/tracker/',showNotification:async(...args)=>shown.push(args)},addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>[],openWindow:async url=>{opened=url;}}};
 vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{self,URL,Set});
 let work;const payload={kind:'admin-message',title:'A message',body:'<b>Hello</b>',url:'https://evil.example',tag:'admin-test'};
 handlers.push({data:{json:()=>payload},waitUntil:p=>work=p});await work;assert.equal(shown[0][0],'A message');assert.equal(shown[0][1].body,'<b>Hello</b>');
 handlers.push({data:{json:()=>({...payload,body:'x'.repeat(501)})},waitUntil:p=>work=p});assert.equal(shown.length,1);
 handlers.notificationclick({notification:{close(){}},waitUntil:p=>work=p});await work;assert.equal(opened,'https://lidoll.dev/tracker/#overview');
});
