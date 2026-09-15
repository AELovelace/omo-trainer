import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const photo=await sharp({create:{width:80,height:60,channels:3,background:'#ca87a5'}}).png().withMetadata().toBuffer();
const upload=(requestId,version=null)=>({requestId,version,picture:{data:photo.toString('base64')}});
function fixture(path=':memory:'){const db=openDatabase(path),a=db.ensureParticipant('test','alice','Alice'),b=db.ensureParticipant('test','bob','Bob'),c=db.ensureParticipant('test','cara','Cara');return {db,a,b,c};}
function connect(db,a,b){const friendship=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:friendship.id});}

test('member profiles show only current readable posts and never expose tracker data or account details',async()=>{
 const {db,a,b,c}=fixture();try{
  connect(db,a,b);const privatePost=await db.social.publish(a.id,{requestId:'private',body:'Friends only'}),publicPost=await db.social.publish(a.id,{requestId:'public',body:'Everyone',audience:'public'});await db.social.publish(b.id,{requestId:'other',body:'Someone else',audience:'public'});
  const own=db.social.memberProfile(a.id);assert.equal(own.member.isSelf,true);assert.equal(own.items.length,2);assert.deepEqual(Object.keys(own.member).sort(),['id','isFriend','isSelf','label']);
  assert.equal(db.social.memberProfile(b.id,a.id).items.length,2);assert.deepEqual(db.social.memberProfile(c.id,a.id).items.map(row=>row.id),[publicPost.id]);assert.equal(db.social.memberProfile(c.id).items.length,0);
  db.friends.act(b.id,{action:'remove',id:db.friends.list(b.id)[0].id});assert.deepEqual(db.social.memberProfile(b.id,a.id).items.map(row=>row.id),[publicPost.id]);
  db.social.deletePost(a.id,publicPost.id);assert.equal(db.social.memberProfile(c.id,a.id).items.length,0);
  db.admin.bootstrap(c.id);const access=db.admin.users(c.id).find(u=>u.id===a.id);db.admin.updateUser(c.id,{action:'update',id:a.id,role:'participant',disabled:true,version:access.version});assert.throws(()=>db.social.memberProfile(b.id,a.id),e=>e.status===404);assert.throws(()=>db.social.memberProfile(b.id,'missing'),e=>e.status===404);assert.throws(()=>db.social.memberProfile(a.id,b.id),e=>e.status===403);
 }finally{db.close();}
});
test('member profile pagination filters the author and audience before selecting a page',async()=>{
 let time=Date.now();const db=openDatabase(':memory:',{now:()=>time}),a=db.ensureParticipant('test','pages','Pages'),b=db.ensureParticipant('test','viewer','Viewer');try{
  for(let i=0;i<25;i++){time+=61000;await db.social.publish(a.id,{requestId:'public'+i,body:'Visible '+i,audience:'public'});await db.social.publish(a.id,{requestId:'private'+i,body:'Private '+i});}
  const first=db.social.memberProfile(b.id,a.id);assert.equal(first.items.length,20);assert.ok(first.items.every(p=>p.audience==='public'));const second=db.social.memberProfile(b.id,a.id,{before:first.nextBefore});assert.equal(second.items.length,5);assert.equal(second.nextBefore,null);assert.ok(second.items.every(p=>!first.items.some(q=>q.id===p.id)));assert.throws(()=>db.social.memberProfile(b.id,a.id,{before:'invalid'}),e=>e.status===400);
 }finally{db.close();}
});

test('profile pictures are sanitized square JPEGs and appear in member identities',async()=>{
 const {db,a,b,c}=fixture();try{
  assert.deepEqual(db.social.profile(a.id),{version:null,avatarVersion:null});connect(db,a,b);await db.social.saveProfile(a.id,upload('one'));
  const meta=await sharp(db.social.avatar(c.id,a.id,'one')).metadata();assert.equal(meta.width,512);assert.equal(meta.height,512);assert.equal(meta.format,'jpeg');assert.equal(meta.exif,undefined);assert.equal(meta.icc,undefined);
  assert.equal(db.friends.list(b.id)[0].avatarVersion,'one');assert.equal(db.friends.search(c.id,'Ali')[0].avatarVersion,'one');assert.equal(db.social.conversations(b.id)[0].friend.avatarVersion,'one');
  const post=await db.social.publish(a.id,{requestId:'post',body:'Hi',audience:'public'});assert.equal(db.social.feed(c.id,{audience:'public'}).items[0].author.avatarVersion,'one');
  db.social.comment(a.id,{requestId:'comment',postId:post.id,body:'Hello'});assert.equal(db.social.commentList(b.id,post.id).items[0].author.avatarVersion,'one');
 }finally{db.close();}
});
test('profile validation, repeat requests and version checks prevent stale replacement and resurrection',async()=>{
 const {db,a}=fixture();try{
  for(const picture of [{data:'https://example.com/a.jpg'},{data:Buffer.from('<svg>not an image</svg>').toString('base64')},{data:Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]).toString('base64')},[],undefined])await assert.rejects(db.social.saveProfile(a.id,{requestId:'bad',picture}),e=>e.status===400);
  const first=upload('first');await db.social.saveProfile(a.id,first);assert.equal((await db.social.saveProfile(a.id,first)).repeated,true);
  await assert.rejects(db.social.saveProfile(a.id,{...first,picture:null}),e=>e.status===409);
  const outcomes=await Promise.allSettled([db.social.saveProfile(a.id,upload('second','first')),db.social.saveProfile(a.id,upload('raced','first'))]);assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);assert.equal(outcomes.find(v=>v.status==='rejected').reason.status,409);
  const version=db.social.profile(a.id).version;const remove={requestId:'removed',version,picture:null};await db.social.saveProfile(a.id,remove);assert.equal((await db.social.saveProfile(a.id,remove)).repeated,true);assert.equal(db.social.profile(a.id).avatarVersion,null);assert.throws(()=>db.social.avatar(a.id,a.id),e=>e.status===404);
  await assert.rejects(db.social.saveProfile(a.id,first),e=>e.status===409);await assert.rejects(db.social.saveProfile(a.id,upload('stale',version)),e=>e.status===409);await db.social.saveProfile(a.id,upload('new','removed'));
  assert.throws(()=>db.social.avatar(a.id,a.id,version),e=>e.status===404);
 }finally{db.close();}
});
test('admins can review and remove current avatars with audit, while restricted or disabled accounts cannot upload',async()=>{
 const {db,a,b,c}=fixture();try{
  db.admin.bootstrap(c.id);await db.social.saveProfile(a.id,upload('first'));assert.throws(()=>db.social.moderation(b.id,{view:'profiles'}),e=>e.status===403);
  assert.equal(db.social.moderation(c.id,{view:'profiles'}).items[0].id,a.id);assert.throws(()=>db.social.moderate(b.id,{action:'remove-profile',participantId:a.id,version:'first',reason:'Test'}),e=>e.status===403);
  await db.social.saveProfile(a.id,upload('second','first'));assert.throws(()=>db.social.moderate(c.id,{action:'remove-profile',participantId:a.id,version:'first',reason:'Test'}),e=>e.status===409);
  db.social.moderate(c.id,{action:'remove-profile',participantId:a.id,version:'second',reason:'Inappropriate picture'});assert.ok(db.admin.auditList(c.id).some(row=>row.action==='social-remove-profile'&&JSON.parse(row.details_json).reason==='Inappropriate picture'));assert.equal(db.social.moderation(c.id,{view:'profiles'}).items.length,0);assert.throws(()=>db.social.avatar(b.id,a.id),e=>e.status===404);
  await assert.rejects(db.social.saveProfile(a.id,upload('second','first')),e=>e.status===409);
  await db.social.saveProfile(a.id,upload('third',db.social.profile(a.id).version));db.social.moderate(c.id,{action:'restrict',participantId:a.id,reason:'Test restriction'});await assert.rejects(db.social.saveProfile(a.id,upload('blocked','third')),e=>e.status===403);
  const member=db.admin.users(c.id).find(u=>u.id===a.id);db.admin.updateUser(c.id,{action:'update',id:a.id,role:'participant',disabled:true,version:member.version});assert.throws(()=>db.social.avatar(b.id,a.id),e=>e.status===404);assert.ok(db.social.avatar(c.id,a.id,'third',true).length);await assert.rejects(db.social.saveProfile(a.id,{requestId:'remove',version:'third',picture:null}),e=>e.status===403);
 }finally{db.close();}
});
test('profile pictures and removal versions persist after restart',async()=>{
 const path=resolve(mkdtempSync(resolve('artifacts/profile-test-')),'profile.sqlite');let {db,a}=fixture(path);try{await db.social.saveProfile(a.id,upload('first'));db.close();db=openDatabase(path);assert.ok(db.social.avatar(a.id,a.id,'first').length);await db.social.saveProfile(a.id,{requestId:'removed',version:'first',picture:null});db.close();db=openDatabase(path);assert.deepEqual(db.social.profile(a.id),{version:'removed',avatarVersion:null});await assert.rejects(db.social.saveProfile(a.id,upload('first')),e=>e.status===409);}finally{db.close();}
});
test('profile HTTP routes require login, CSRF and live roles; uploads can only change the session owner',async()=>{
 const {db,a,b,c}=fixture();db.admin.bootstrap(c.id);const tokens=new Map([a,b,c].map(u=>[u.id,db.createSession(u.id)])),login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login);
 const server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 const get=(user,path)=>fetch(login.origin+'/'+path,{headers:user?{Cookie:tokens.get(user.id)}:{}}),post=(user,path,input,headers={})=>fetch(login.origin+'/'+path,{method:'POST',headers:{Cookie:tokens.get(user.id),Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':db.session(tokens.get(user.id)).csrf,...headers},body:JSON.stringify(input)});
 try{
  assert.equal((await get(null,'social/profile')).status,401);assert.equal((await post(a,'social/profile',upload('bad'),{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await get(null,'social/member?id='+a.id)).status,401);const member=await get(b,'social/member?id='+a.id);assert.equal(member.headers.get('cache-control'),'no-store');assert.equal((await member.json()).member.id,a.id);assert.equal((await (await get(b,'social/member')).json()).member.id,b.id);
  const saved=await post(a,'social/profile',{...upload('first'),owner:b.id,participantId:b.id});assert.equal(saved.status,200);const result=await saved.json();assert.equal(result.csrf,db.session(tokens.get(a.id)).csrf);assert.equal(result.participant.avatarVersion,'first');assert.equal(db.social.profile(b.id).avatarVersion,null);
  const path='social/avatar?owner='+a.id+'&version=first';assert.equal((await get(null,path)).status,401);const image=await get(b,path);assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'no-store');assert.equal(image.headers.get('content-type'),'image/jpeg');assert.equal(image.headers.get('x-content-type-options'),'nosniff');assert.equal(image.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal((await get(b,'admin/social?view=profiles')).status,403);assert.equal((await get(b,'admin/'+path)).status,403);assert.equal((await get(c,'admin/'+path)).status,200);
  assert.equal((await post(c,'admin/social',{action:'remove-profile',participantId:a.id,version:'first',reason:'Review'})).status,200);assert.equal((await get(b,path)).status,404);
 }finally{await new Promise(r=>server.close(r));db.close();}
});
