import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import sharp from 'sharp';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {createNotifications} from '../server/notifications.mjs';
const instant=Date.parse('2026-09-15T14:00:00Z');
const pref=(id,extra={})=>({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}},timeZone:'UTC',quietStart:0,quietEnd:0,...extra});
const post=(requestId,extra={})=>({requestId,body:'Private post text',audience:'friends',...extra});
function connect(db,a,b){const f=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:f.id});return f.id;}
function fixture(){const sent=[];let time=instant;const db=openDatabase(':memory:',{now:()=>time,notifications:{send:async(s,p)=>sent.push({s,p}),random:()=>99}}),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob'),c=db.ensureParticipant('test','c','Cara'),admin=db.ensureParticipant('test','admin','Admin');db.admin.bootstrap(admin.id);const link=connect(db,a,b);return {db,a,b,c,admin,sent,link,advance:()=>time+=60001};}

test('likes, comments and friend posts create private stored activity with safe retries and independent push preferences',async()=>{
 const {db,a,b,c,sent}=fixture();try{
  db.notifications.save(a.id,pref('a'));db.notifications.save(b.id,pref('b'));
  const p=await db.social.publish(a.id,post('first'));await db.social.publish(a.id,post('first'));
  assert.equal(db.activity.list(b.id).items.length,1);assert.equal(db.activity.list(c.id).items.length,0);assert.equal(db.activity.list(a.id).items.length,0);
  assert.throws(()=>db.social.like(c.id,{postId:p.id,liked:true}),e=>e.status===404);assert.throws(()=>db.social.commentList(c.id,p.id),e=>e.status===404);
  db.social.like(b.id,{postId:p.id,liked:true});db.social.like(b.id,{postId:p.id,liked:true});
  const input={requestId:'comment',postId:p.id,body:'Hello <script>literal</script>'};const comment=db.social.comment(b.id,input);assert.equal(db.social.comment(b.id,input).id,comment.id);assert.throws(()=>db.social.comment(b.id,{...input,body:'Changed'}),e=>e.status===409);
  assert.equal(db.social.post(a.id,p.id).likes,1);assert.equal(db.social.post(a.id,p.id).comments,1);assert.equal(db.activity.list(a.id).unread,2);
  await db.notifications.tick(instant);assert.equal(sent.length,3);assert.ok(sent.every(({p})=>p.kind==='social-activity'&&!p.body.includes('Private')&&!p.body.includes('<script>')));await db.notifications.tick(instant);assert.equal(sent.length,3);
  const history=db.activity.list(a.id);db.activity.read(a.id,{id:history.items[0].id});assert.equal(db.activity.list(a.id).unread,1);db.activity.read(c.id,{id:history.items[1].id});assert.equal(db.activity.list(a.id).unread,1);assert.throws(()=>db.activity.read(c.id,{through:history.latest}),e=>e.status===400);
  db.notifications.save(a.id,pref('a',{socialComments:false}));db.social.comment(b.id,{...input,requestId:'second'});await db.notifications.tick(instant);assert.equal(sent.length,3);assert.equal(db.activity.list(a.id).items.length,3);
  db.activity.read(a.id,{through:history.latest});assert.equal(db.activity.list(a.id).unread,1,'A new arrival is not marked by an earlier mark-all cursor');
  db.social.like(b.id,{postId:p.id,liked:false});db.social.like(b.id,{postId:p.id,liked:true});await db.notifications.tick(instant);assert.equal(sent.length,3,'Like toggles never repeatedly notify');
 }finally{db.close();}
});

test('public interactions allow nonfriends; comments enforce ownership, input limits and stable pagination',async()=>{
 const {db,a,b,c,advance}=fixture();try{
  const p=await db.social.publish(a.id,post('public',{audience:'public'}));db.social.like(c.id,{postId:p.id,liked:true});
  const first=db.social.comment(c.id,{requestId:'first',postId:p.id,body:'First'});for(let i=0;i<32;i++){advance();db.social.comment(b.id,{requestId:'page'+i,postId:p.id,body:'Page '+i});}
  const page=db.social.commentList(c.id,p.id),older=db.social.commentList(c.id,p.id,{before:page.nextBefore});assert.equal(page.items.length,30);assert.equal(older.items.length,3);assert.equal(older.items[0].id,first.id);
  assert.throws(()=>db.social.deleteComment(b.id,first.id),e=>e.status===403);db.social.deleteComment(a.id,first.id);assert.equal(db.social.post(a.id,p.id).comments,32);
  assert.equal(db.social.comment(c.id,{requestId:'first',postId:p.id,body:'First'}).id,first.id);assert.equal(db.social.post(a.id,p.id).comments,32);
  for(const body of ['',null,'a'.repeat(2001)])assert.throws(()=>db.social.comment(c.id,{requestId:'invalid',postId:p.id,body}),e=>e.status===400);
  assert.throws(()=>db.social.like(c.id,{postId:p.id,liked:'true'}),e=>e.status===400);
 }finally{db.close();}
});

test('quiet hours defer social pushes; opt-out, device removal, friend removal, content removal and expiry prevent replay',async()=>{
 const {db,a,b,sent,link}=fixture();try{
  db.notifications.save(a.id,pref('a'));db.notifications.save(b.id,pref('b',{quietStart:13,quietEnd:15}));
  const p=await db.social.publish(a.id,post('quiet'));await db.notifications.tick(instant);assert.equal(sent.length,0);
  await db.notifications.tick(instant+2*3600000);assert.equal(sent.length,1);
  await db.social.publish(a.id,post('optout'));db.notifications.save(b.id,pref('b',{friendPosts:false}));db.notifications.save(b.id,pref('b',{friendPosts:true}));await db.notifications.tick(instant);assert.equal(sent.length,1);
  await db.social.publish(a.id,post('device'));db.notifications.remove(b.id,{all:true});db.notifications.save(b.id,pref('b'));await db.notifications.tick(instant);assert.equal(sent.length,1);
  await db.social.publish(a.id,post('remove'));db.friends.act(a.id,{action:'remove',id:link});connect(db,a,b);await db.notifications.tick(instant);assert.equal(sent.length,1);assert.equal(db.activity.list(b.id).items.length,0);
  await db.social.publish(a.id,post('expired'));await db.notifications.tick(instant+86400001);assert.equal(sent.length,1);assert.equal(db.activity.list(b.id).items.length,1,'Expiry of a push does not erase stored activity');
  db.social.like(b.id,{postId:p.id,liked:true});db.social.deletePost(a.id,p.id);await db.notifications.tick(instant);assert.equal(sent.length,1);assert.equal(db.activity.list(a.id).items.length,0);
 }finally{db.close();}
});

test('moderators can review reports, remove content and restrict social writes with audit and live role checks',async()=>{
 const {db,a,b,c,admin}=fixture();try{
  const p=await db.social.publish(a.id,post('moderate'));const comment=db.social.comment(b.id,{requestId:'bad',postId:p.id,body:'Reported comment'});
  assert.throws(()=>db.social.report(c.id,{kind:'post',id:p.id,reason:'No access'}),e=>e.status===404);
  const input={kind:'comment',id:comment.id,reason:'Please review'};const report=db.social.report(a.id,input);assert.equal(db.social.report(a.id,input).id,report.id);
  assert.throws(()=>db.social.moderation(b.id),e=>e.status===403);assert.equal(db.social.moderation(admin.id).items[0].content.body,'Reported comment');
  assert.throws(()=>db.social.moderate(admin.id,{action:'remove',kind:'comment',id:comment.id,reason:''}),e=>e.status===400);
  db.social.moderate(admin.id,{action:'remove',kind:'comment',id:comment.id,reason:'Removed after review'});assert.equal(db.social.commentList(a.id,p.id).items.length,0);assert.equal(db.social.moderation(admin.id).items.length,0);assert.equal(db.activity.list(a.id).items.length,0);
  db.social.moderate(admin.id,{action:'restrict',participantId:a.id,reason:'Pause for review'});await assert.rejects(db.social.publish(a.id,post('blocked')),e=>e.status===403);assert.throws(()=>db.social.sendMessage(a.id,{participantId:b.id,requestId:'blocked',body:'No'}),e=>e.status===403);assert.throws(()=>db.social.comment(a.id,{postId:p.id,requestId:'blocked',body:'No'}),e=>e.status===403);assert.equal(db.social.post(a.id,p.id).id,p.id);
  db.social.moderate(admin.id,{action:'restore',participantId:a.id,reason:'Review complete'});await db.social.publish(a.id,post('restored'));
  db.social.moderate(admin.id,{action:'remove',kind:'post',id:p.id,reason:'Remove post'});assert.throws(()=>db.social.post(b.id,p.id),e=>e.status===404);assert.ok(db.admin.auditList(admin.id).some(r=>r.action==='social-remove'&&JSON.parse(r.details_json).reason==='Remove post'));
  const other=db.admin.users(admin.id).find(u=>u.id===b.id);db.admin.updateUser(admin.id,{action:'update',id:b.id,role:'admin',disabled:false,version:other.version});const promoted=db.admin.users(admin.id).find(u=>u.id===b.id);db.admin.updateUser(admin.id,{action:'update',id:b.id,role:'participant',disabled:false,version:promoted.version});assert.throws(()=>db.social.moderation(b.id),e=>e.status===403);
 }finally{db.close();}
});

test('private message moderation requires a report from a conversation participant',()=>{
 const {db,a,b,c,admin}=fixture();try{
  const message=db.social.sendMessage(a.id,{participantId:b.id,requestId:'dm',body:'Private message'});
  assert.throws(()=>db.social.report(c.id,{kind:'message',id:message.id,reason:'Guess'}),e=>e.status===404);
  assert.throws(()=>db.social.moderate(admin.id,{action:'remove',kind:'message',id:message.id,reason:'No report'}),e=>e.status===403);assert.equal(db.social.moderation(admin.id).items.length,0);
  db.social.report(b.id,{kind:'message',id:message.id,reason:'Review this message'});assert.equal(db.social.moderation(admin.id).items[0].content.body,'Private message');
  db.social.moderate(admin.id,{action:'remove',kind:'message',id:message.id,reason:'Removed reported message'});assert.equal(db.social.messages(a.id,b.id).items[0].body,'');
 }finally{db.close();}
});

test('existing notification subscribers get social defaults once, with persistent opt-outs and no backfill',()=>{
 const raw=new DatabaseSync(':memory:');try{
  raw.exec("CREATE TABLE participants(id TEXT PRIMARY KEY);CREATE TABLE participant_access(participant_id TEXT PRIMARY KEY,disabled INTEGER);CREATE TABLE notification_preferences(owner TEXT PRIMARY KEY,time_zone TEXT,quiet_start INTEGER,quiet_end INTEGER,admin_messages INTEGER);CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,owner TEXT,payload TEXT);INSERT INTO participants VALUES ('old');INSERT INTO notification_preferences VALUES ('old','UTC',0,0,0)");const p=pref('old');raw.prepare('INSERT INTO push_subscriptions VALUES (?,?,?)').run(p.subscription.endpoint,'old',JSON.stringify(p.subscription));
  const options={send:async()=>{throw Error('No backfill');}};let service=createNotifications(raw,()=>[],options);assert.equal(service.status('old').preferences.socialLikes,1);assert.equal(service.status('old').preferences.socialComments,1);assert.equal(service.status('old').preferences.friendPosts,1);
  service.save('old',pref('old',{socialLikes:false,socialComments:false,friendPosts:false}));service=createNotifications(raw,()=>[],options);service.save('old',pref('new-device'));assert.equal(service.status('old').preferences.socialLikes,0);assert.equal(service.status('old').preferences.socialComments,0);assert.equal(service.status('old').preferences.friendPosts,0);assert.throws(()=>service.save('old',pref('old',{socialLikes:null})),e=>e.status===400);
 }finally{raw.close();}
});

test('stored activity, read state and pending delivery persist; failed transport never duplicates and cleans expired endpoints',async()=>{
 const directory=mkdtempSync(resolve('artifacts/activity-persist-')),path=resolve(directory,'science.sqlite'),sent=[];const options={now:()=>instant,notifications:{send:async(s,p)=>{sent.push(p);throw Object.assign(Error('gone'),{statusCode:410});},random:()=>99}};let db=openDatabase(path,options);try{
  const a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');connect(db,a,b);db.notifications.save(b.id,pref('b'));await db.social.publish(a.id,post('persist'));const first=db.activity.list(b.id);db.activity.read(b.id,{id:first.items[0].id});db.close();db=openDatabase(path,options);assert.equal(db.activity.list(b.id).items.length,1);assert.equal(db.activity.list(b.id).unread,0);await db.notifications.tick(instant);await db.notifications.tick(instant);assert.equal(sent.length,1);assert.equal(db.notifications.status(b.id).subscriptions,0);assert.equal(db.activity.list(b.id).items.length,1);
 }finally{db.close();}
});

test('activity pagination and mark-all do not leak another account or lose newer notifications',()=>{
 const {db,a,b}=fixture();try{for(let i=0;i<35;i++)db.activity.record(a.id,{source:'test:'+i,kind:'reminder',title:'Reminder',body:'Test'});const first=db.activity.list(a.id),last=db.activity.list(a.id,{before:first.nextBefore});assert.equal(first.items.length,30);assert.equal(last.items.length,5);assert.equal(db.activity.list(b.id).items.length,0);assert.ok(!last.items.some(v=>first.items.some(f=>f.id===v.id)));db.activity.read(a.id,{through:first.latest});assert.equal(db.activity.list(a.id).unread,0);}finally{db.close();}
});

test('moderation and activity HTTP routes enforce admin roles, CSRF and current session ownership',async()=>{
 const {db,a,b,admin}=fixture(),tokens=new Map([a,b,admin].map(u=>[u.id,db.createSession(u.id)])),login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 const get=(u,path)=>fetch(login.origin+'/'+path,{headers:u?{Cookie:tokens.get(u.id)}:{}}),send=(u,path,body,csrf=db.session(tokens.get(u.id)).csrf)=>fetch(login.origin+'/'+path,{method:'POST',headers:{Cookie:tokens.get(u.id),Origin:login.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{const p=await db.social.publish(a.id,post('api'));assert.equal((await get(null,'social/activity')).status,401);assert.equal((await get(b,'admin/social')).status,403);assert.equal((await get(b,'admin/social/picture?id=anything')).status,403);assert.equal((await send(b,'social/like',{postId:p.id,liked:true},'bad')).status,403);assert.equal((await send(b,'social/like',{postId:p.id,liked:true})).status,200);assert.equal((await send(admin,'admin/social',{action:'remove',kind:'post',id:p.id,reason:'Test'},'bad')).status,403);const response=await get(b,'social/activity');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).items.length,1);assert.equal((await get(admin,'admin/social?view=posts')).status,200);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});

test('social pushes validate text and open only the local activity feed',async()=>{
 const handlers={},shown=[];let opened,work;const self={registration:{scope:'https://lidoll.dev/tracker/',showNotification:async(...args)=>shown.push(args)},addEventListener:(n,f)=>handlers[n]=f,clients:{matchAll:async()=>[],openWindow:async url=>{opened=url;}}};vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{self,URL,Set});
 handlers.push({data:{json:()=>({kind:'social-activity',title:'New like',body:'Bob liked your post.',url:'https://evil.example'})},waitUntil:p=>work=p});await work;assert.equal(shown[0][0],'New like');assert.equal(shown[0][1].data.activity,true);handlers.notificationclick({notification:{data:shown[0][1].data,close(){}},waitUntil:p=>work=p});await work;assert.equal(opened,'https://lidoll.dev/tracker/#activity');handlers.push({data:{json:()=>({kind:'social-activity',title:'New like',body:'x'.repeat(501)})},waitUntil:p=>work=p});assert.equal(shown.length,1);
});

test('admin picture review bypasses friend visibility only with a live admin role and removals revoke picture access',async()=>{
 const {db,a,c,admin}=fixture();try{
  const image=await sharp({create:{width:8,height:8,channels:3,background:'#cc8899'}}).png().toBuffer();const p=await db.social.publish(a.id,post('photo',{pictures:[{data:image.toString('base64')}]}));const picture=db.social.post(a.id,p.id).pictures[0].id;
  assert.throws(()=>db.social.photo(admin.id,picture),e=>e.status===404);assert.ok(db.social.moderationPhoto(admin.id,picture).length);assert.throws(()=>db.social.moderationPhoto(c.id,picture),e=>e.status===403);
  db.social.moderate(admin.id,{action:'remove',kind:'post',id:p.id,reason:'Remove image post'});assert.throws(()=>db.social.moderationPhoto(admin.id,picture),e=>e.status===404);
 }finally{db.close();}
});

test('disabled actors and removed comments cannot deliver queued activity or expose it through history',async()=>{
 const {db,a,b,admin,sent}=fixture();try{
  db.notifications.save(a.id,pref('a'));db.notifications.save(b.id,pref('b'));const p=await db.social.publish(a.id,post('private'));
  const comment=db.social.comment(b.id,{postId:p.id,requestId:'gone',body:'Gone soon'});db.social.deleteComment(b.id,comment.id);db.social.like(b.id,{postId:p.id,liked:true});
  const row=db.admin.users(admin.id).find(u=>u.id===b.id);db.admin.updateUser(admin.id,{action:'update',id:b.id,role:'participant',disabled:true,version:row.version});await db.notifications.tick(instant);assert.equal(sent.length,0);assert.equal(db.activity.list(a.id).items.length,0);
 }finally{db.close();}
});

test('admin announcements and community notifications are stored once with their delivered anonymity',async()=>{
 const {db,a,b,admin}=fixture();try{
  db.notifications.save(a.id,pref('a',{adminMessages:true,communityAnonymous:true}));db.notifications.save(b.id,pref('b'));
  db.notifications.messages.queue(admin.id,{requestId:'announcement',title:'Hello members',body:'A saved announcement',participantId:a.id},instant);
  db.notifications.community.queue(a.id,{day:'2026-09-15',instant});await db.notifications.tick(instant);await db.notifications.tick(instant);
  const announcement=db.activity.list(a.id).items.filter(x=>x.kind==='admin-message');assert.equal(announcement.length,1);assert.equal(announcement[0].body,'A saved announcement');
  const community=db.activity.list(b.id).items.filter(x=>x.kind==='community-checkin');assert.equal(community.length,1);assert.ok(!community[0].body.includes('Alice'));
  db.notifications.save(a.id,pref('a',{communityAnonymous:false}));assert.equal(db.activity.list(b.id).items[0].body,community[0].body,'Stored anonymous notifications do not reveal names later');
 }finally{db.close();}
});

test('Community support filters stored notices, unread counts and paging while other push history stays visible',()=>{
 const {db,a,b}=fixture();try{
  db.notifications.save(a.id,pref('a'));
  for(let i=0;i<35;i++){
   db.activity.record(a.id,{source:'push:'+i,kind:i%2?'admin-message':'reminder',title:'Saved push',body:'Keep this notification'});
   db.activity.record(a.id,{source:'community:'+i,kind:'community-checkin',title:'Community check-in',body:'Anonymous check-in'});
  }
  const enabled=db.activity.list(a.id),hiddenId=enabled.items[0].id;assert.equal(enabled.unread,70);
  db.notifications.save(a.id,pref('a',{communitySupport:false}));
  const first=db.activity.list(a.id),second=db.activity.list(a.id,{before:first.nextBefore});assert.equal(first.unread,35);assert.equal(first.items.length,30);assert.equal(second.items.length,5);assert.equal(second.nextBefore,null);assert.ok([...first.items,...second.items].every(n=>n.kind!=='community-checkin'));assert.ok(first.latest<enabled.latest);
  db.activity.read(a.id,{id:hiddenId});assert.throws(()=>db.activity.read(a.id,{through:enabled.latest}),e=>e.status===400);
  db.activity.read(a.id,{through:first.latest});assert.equal(db.activity.list(a.id).unread,0);
  assert.equal(db.activity.record(a.id,{source:'community:off',kind:'community-checkin',title:'Off',body:'Must not be recorded'}),undefined);
  assert.equal(db.activity.record(b.id,{source:'community:unset',kind:'community-checkin',title:'Unset',body:'Must not be recorded'}),undefined);
  db.notifications.save(a.id,pref('a',{communitySupport:true}));const restored=db.activity.list(a.id);assert.equal(restored.unread,35,'Hidden notices retain their previous read state');assert.equal(restored.latest,enabled.latest);assert.equal(restored.items.find(n=>n.id===hiddenId).read,false);
 }finally{db.close();}
});
