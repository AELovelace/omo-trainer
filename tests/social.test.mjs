import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const now=Date.parse('2026-09-15T14:00:00Z');
const photo=await sharp({create:{width:32,height:24,channels:3,background:'#cc6699'}}).jpeg().withMetadata().toBuffer();
const input=(id,extra={})=>({requestId:id,body:'Hello <b>friends</b>',audience:'friends',pictures:[],...extra});
function fixture(){let time=now;const db=openDatabase(':memory:',{stickerCatalog:[],now:()=>time});return {db,a:db.ensureParticipant('test','a','Alice'),b:db.ensureParticipant('test','b','Bob'),c:db.ensureParticipant('test','c','Cara'),tick:()=>time+=60001};}
function connect(db,a,b){const row=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:row.id});return row.id;}
function disable(db,a,b){db.admin.bootstrap(a.id);const row=db.admin.users(a.id).find(u=>u.id===b.id);db.admin.updateUser(a.id,{action:'update',id:b.id,role:'participant',disabled:true,version:row.version});}

test('friends and public feeds enforce current audiences and image access without exposing original metadata',async()=>{
 const {db,a,b,c}=fixture();try {
  const link=connect(db,a,b);const post=await db.social.publish(a.id,input('picture',{pictures:[{data:photo.toString('base64'),alt:'A pink square'}]}));
  assert.equal(db.social.feed(a.id).items.length,1);const seen=db.social.feed(b.id).items[0];assert.equal(seen.id,post.id);assert.equal(seen.pictures[0].alt,'A pink square');assert.equal(db.social.feed(c.id).items.length,0);
  const id=seen.pictures[0].id;assert.throws(()=>db.social.photo(c.id,id),e=>e.status===404);const sanitized=await sharp(db.social.photo(b.id,id)).metadata();assert.equal(sanitized.format,'jpeg');assert.equal(sanitized.exif,undefined);assert.equal(sanitized.icc,undefined);
  db.friends.act(a.id,{action:'remove',id:link});assert.throws(()=>db.social.photo(b.id,id),e=>e.status===404);
  const publicPost=await db.social.publish(a.id,input('public',{audience:'public',pictures:[{data:photo.toString('base64')}]}));const listed=db.social.feed(c.id,{audience:'public'}).items;assert.equal(listed.length,1);assert.equal(listed[0].id,publicPost.id);assert.ok(db.social.photo(c.id,listed[0].pictures[0].id).length>0);
  disable(db,a,c);assert.throws(()=>db.social.feed(c.id,{audience:'public'}),e=>e.status===403);
 }finally{db.close();}
});

test('posts validate content, decode pictures, reject active formats and delete without resurrection on retry',async()=>{
 const {db,a,b}=fixture();try {
  for(const value of [input('bad-empty',{body:''}),input('bad-audience',{audience:'anyone'}),input('bad-text',{body:'x'.repeat(2001)}),input('bad-many',{pictures:Array(5).fill({data:photo.toString('base64')})}),input('bad-svg',{pictures:[{data:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}]}),input('bad-png',{pictures:[{data:Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]).toString('base64')}]}),input('bad-base64',{pictures:[{data:'https://evil.example/a.jpg'}]})])await assert.rejects(db.social.publish(a.id,value),e=>e.status===400);
  const value=input('repeat',{pictures:[{data:photo.toString('base64')}]});const first=await db.social.publish(a.id,value);assert.equal((await db.social.publish(a.id,value)).id,first.id);
  await assert.rejects(db.social.publish(a.id,{...value,body:'Changed'}),e=>e.status===409);const image=db.social.feed(a.id).items[0].pictures[0].id;
  assert.throws(()=>db.social.deletePost(b.id,first.id),e=>e.status===404);db.social.deletePost(a.id,first.id);assert.throws(()=>db.social.photo(a.id,image),e=>e.status===404);assert.equal((await db.social.publish(a.id,value)).deleted,true);assert.equal(db.social.feed(a.id).items.length,0);
 }finally{db.close();}
});

test('feed cursor pagination survives new posts and disabled authors disappear',async()=>{
 const {db,a,b,tick}=fixture();try {
  for(let i=0;i<22;i++){tick();await db.social.publish(a.id,input('page'+i,{audience:'public'}));}
  const page=db.social.feed(b.id,{audience:'public'});assert.equal(page.items.length,20);tick();await db.social.publish(a.id,input('new',{audience:'public'}));
  const older=db.social.feed(b.id,{audience:'public',before:page.nextBefore});assert.equal(older.items.length,2);assert.ok(!older.items.some(row=>page.items.some(item=>item.id===row.id)));
  disable(db,b,a);assert.equal(db.social.feed(b.id,{audience:'public'}).items.length,0);assert.throws(()=>db.social.feed(b.id,{before:'bad'}));
 }finally{db.close();}
});

test('messages are private, retry safe, paginated, removable and have monotonic unread cursors',()=>{
 const {db,a,b,c,tick}=fixture();try {
  const send=(id,body='Hello')=>db.social.sendMessage(a.id,{requestId:id,participantId:b.id,body});assert.throws(()=>send('pending'),e=>e.status===403);connect(db,a,b);
  const first=send('first');assert.equal(send('first').id,first.id);assert.throws(()=>send('first','Changed'),e=>e.status===409);
  assert.throws(()=>db.social.messages(c.id,a.id),e=>e.status===403);assert.equal(db.social.conversations(b.id)[0].unread,1);const seq=db.social.messages(b.id,a.id).items[0].seq;
  assert.throws(()=>db.social.readMessages(b.id,{participantId:a.id,seq:999}),e=>e.status===400);db.social.readMessages(b.id,{participantId:a.id,seq});assert.equal(db.social.conversations(b.id)[0].unread,0);
  for(let i=0;i<51;i++){tick();send('page'+i);}const page=db.social.messages(b.id,a.id);assert.equal(page.items.length,50);assert.equal(db.social.messages(b.id,a.id,{before:page.nextBefore}).items.length,2);
  db.social.readMessages(b.id,{participantId:a.id,seq:page.items.at(-1).seq});db.social.readMessages(b.id,{participantId:a.id,seq});assert.equal(db.social.conversations(b.id)[0].unread,0);
  assert.throws(()=>db.social.deleteMessage(b.id,first.id),e=>e.status===404);db.social.deleteMessage(a.id,first.id);assert.equal(send('first').id,first.id);assert.equal(db.social.messages(b.id,a.id,{before:page.nextBefore}).items[0].body,'');
 }finally{db.close();}
});

test('removing and re-adding friends cannot restore a conversation or replay an old message',()=>{
 const {db,a,b}=fixture();try {
  const link=connect(db,a,b),message={requestId:'old',participantId:b.id,body:'Before removal'};db.social.sendMessage(a.id,message);db.friends.act(b.id,{action:'remove',id:link});assert.throws(()=>db.social.messages(a.id,b.id),e=>e.status===403);
  connect(db,a,b);assert.equal(db.social.messages(a.id,b.id).items.length,0);assert.throws(()=>db.social.sendMessage(a.id,message),e=>e.status===409);
  disable(db,a,b);assert.throws(()=>db.social.sendMessage(a.id,{...message,requestId:'disabled'}),e=>e.status===403);
 }finally{db.close();}
});

test('mail archives belong to one viewer, preserve unread messages and resurface after new mail',()=>{
 const {db,a,b,c,tick}=fixture();try {
  const link=connect(db,a,b);db.social.sendMessage(a.id,{requestId:'archive-first',participantId:b.id,body:'Keep this'});
  const archive={participantId:a.id,archived:true};db.social.archiveMessages(b.id,archive);db.social.archiveMessages(b.id,archive);
  assert.equal(db.social.conversations(b.id)[0].archived,true);assert.equal(db.social.conversations(b.id)[0].unread,1);assert.equal(db.social.conversations(a.id)[0].archived,false);
  assert.equal(db.social.messages(b.id,a.id).items[0].body,'Keep this');
  assert.throws(()=>db.social.archiveMessages(c.id,archive),e=>e.status===403);
  assert.throws(()=>db.social.archiveMessages(b.id,{...archive,archived:'true'}),e=>e.status===400);
  db.social.archiveMessages(b.id,{...archive,archived:false});assert.equal(db.social.conversations(b.id)[0].archived,false);
  db.social.archiveMessages(b.id,archive);tick();db.social.sendMessage(a.id,{requestId:'archive-new',participantId:b.id,body:'New mail'});assert.equal(db.social.conversations(b.id)[0].archived,false);
  db.social.archiveMessages(b.id,archive);db.friends.act(b.id,{action:'remove',id:link});assert.throws(()=>db.social.archiveMessages(b.id,archive),e=>e.status===403);
  connect(db,a,b);assert.equal(db.social.conversations(b.id)[0].archived,false);disable(db,a,b);assert.throws(()=>db.social.archiveMessages(b.id,archive),e=>e.status===403);
 }finally{db.close();}
});

test('pictures, posts, messages and read markers persist across server restarts',async()=>{
 const dir=mkdtempSync(resolve('artifacts/social-persist-')),file=resolve(dir,'science.sqlite');let db=openDatabase(file,{stickerCatalog:[]});try {
  const a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');connect(db,a,b);await db.social.publish(a.id,input('persist',{pictures:[{data:photo.toString('base64')}]}));db.social.sendMessage(a.id,{requestId:'persist',participantId:b.id,body:'Saved hello'});db.close();db=openDatabase(file,{stickerCatalog:[]});
  const post=db.social.feed(b.id).items[0];assert.ok(db.social.photo(b.id,post.pictures[0].id).length);assert.equal(db.social.messages(b.id,a.id).items[0].body,'Saved hello');assert.equal(db.social.conversations(b.id)[0].unread,1);
  db.social.archiveMessages(b.id,{participantId:a.id,archived:true});db.close();db=openDatabase(file,{stickerCatalog:[]});assert.equal(db.social.conversations(b.id)[0].archived,true);assert.equal(db.social.conversations(a.id)[0].archived,false);
 }finally{db.close();}
});

test('social HTTP endpoints require sessions, CSRF and live audiences, including direct image requests',async()=>{
 const {db,a,b,c}=fixture();connect(db,a,b);const tokens=new Map([a,b,c].map(u=>[u.id,db.createSession(u.id)])),login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login);
 const server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 const get=(user,path)=>fetch(login.origin+'/'+path,{headers:user?{Cookie:tokens.get(user.id)}:{}});
 const post=(user,path,input,headers={})=>fetch(login.origin+'/'+path,{method:'POST',headers:{Cookie:tokens.get(user.id),Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':db.session(tokens.get(user.id)).csrf,...headers},body:JSON.stringify(input)});
 try {
  assert.equal((await get(null,'social/feed?audience=public')).status,401);
  assert.equal((await get(null,'social/session')).status,401);const composer=await get(a,'social/session');assert.equal(composer.headers.get('cache-control'),'no-store');assert.deepEqual(Object.keys(await composer.json()).sort(),['csrf','participant']);
  assert.equal((await post(a,'social/posts',input('csrf'),{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await post(a,'social/posts',input('picture',{pictures:[{data:photo.toString('base64')}]}))).status,200);
  const id=db.social.feed(b.id).items[0].pictures[0].id;assert.equal((await get(null,'social/picture?id='+id)).status,401);assert.equal((await get(c,'social/picture?id='+id)).status,404);
  const image=await get(b,'social/picture?id='+id);assert.equal(image.headers.get('content-type'),'image/jpeg');assert.equal(image.headers.get('cache-control'),'no-store');assert.equal(image.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await post(c,'social/messages',{participantId:b.id,requestId:'forged',sender:a.id,body:'No'})).status,403);
  assert.equal((await post(b,'social/messages/archive',{participantId:a.id,archived:true},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await post(c,'social/messages/archive',{participantId:a.id,archived:true})).status,403);
  assert.equal((await fetch(login.origin+'/social/messages/archive',{method:'POST',headers:{Origin:login.origin,'Content-Type':'application/json'},body:JSON.stringify({participantId:a.id,archived:true})})).status,401);
  assert.equal((await post(b,'social/messages/archive',{participantId:a.id,archived:true,owner:a.id})).status,200);assert.equal(db.social.conversations(a.id)[0].archived,false);
  const shared=await get(b,'social/feed');assert.equal(shared.headers.get('cache-control'),'no-store');assert.equal((await shared.json()).items.length,1);
 }finally{await new Promise(r=>server.close(r));db.close();}
});
