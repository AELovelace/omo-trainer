import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
const instant=Date.parse('2026-09-15T14:00:00Z');
const pref=(id,extra={})=>({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}},timeZone:'UTC',quietStart:0,quietEnd:0,communitySupport:false,...extra});
function fixture(){const sent=[],db=openDatabase(':memory:',{now:()=>instant,notifications:{send:async(s,p)=>sent.push({s,p}),random:()=>99}}),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob'),c=db.ensureParticipant('test','c','Cara');const link=db.friends.act(a.id,{action:'request',participantId:b.id});db.friends.act(b.id,{action:'accept',id:link.id});db.notifications.save(b.id,pref('b'));return {db,a,b,c,sent,link};}
const message=(peer,id)=>({participantId:peer.id,requestId:id,body:'Private message text '+id});
test('new messages atomically create one recipient alert and safe push; unread polling reveals only counts',async()=>{
 const {db,a,b,c,sent}=fixture();try{
  const input=message(b,'first'),saved=db.social.sendMessage(a.id,input);assert.equal(db.social.sendMessage(a.id,input).id,saved.id);assert.equal(db.activity.list(b.id).items.length,1);assert.equal(db.activity.list(a.id).items.length,0);assert.equal(db.social.unreadMessages(b.id).unread,1);assert.equal(db.social.unreadMessages(c.id).unread,0);assert.deepEqual(Object.keys(db.social.unreadMessages(b.id)).sort(),['latest','unread']);
  db.social.archiveMessages(b.id,{participantId:a.id,archived:true});assert.equal(db.social.unreadMessages(b.id).unread,1,'Archived unread messages still count');await db.notifications.tick(instant);await db.notifications.tick(instant);assert.equal(sent.length,1);assert.equal(sent[0].p.title,'New message');assert.equal(sent[0].p.body,'Alice sent you a message.');assert.equal(sent[0].p.messages,true);assert.ok(!JSON.stringify(sent).includes(input.body));assert.equal(db.activity.list(b.id).items[0].messagePeer,a.id);
 }finally{db.close();}
});
test('reading suppresses unsent message pushes and marks stored alerts read; opt-out cancels without replay',async()=>{
 const {db,a,b,sent}=fixture();try{
  db.social.sendMessage(a.id,message(b,'read'));const seq=db.social.messages(b.id,a.id).items[0].seq;db.social.readMessages(b.id,{participantId:a.id,seq});assert.equal(db.social.unreadMessages(b.id).unread,0);assert.equal(db.activity.list(b.id).items[0].read,true);await db.notifications.tick(instant);assert.equal(sent.length,0);
  db.social.sendMessage(a.id,message(b,'queued'));db.notifications.save(b.id,pref('b',{directMessages:false}));db.social.sendMessage(a.id,message(b,'off'));db.notifications.save(b.id,pref('b',{directMessages:true}));await db.notifications.tick(instant);assert.equal(sent.length,0);assert.equal(db.social.unreadMessages(b.id).unread,2);
  db.social.sendMessage(a.id,message(b,'on'));await db.notifications.tick(instant);assert.equal(sent.length,1);assert.equal(db.social.unreadMessages(b.id).unread,3);
 }finally{db.close();}
});
test('message deletion, friendship revocation and disabled senders revoke badges, activity and pending pushes',async()=>{
 for(const action of ['delete','unfriend','disable']){const {db,a,b,c,sent,link}=fixture();try{
  const saved=db.social.sendMessage(a.id,message(b,action));
  if(action==='delete')db.social.deleteMessage(a.id,saved.id);else if(action==='unfriend')db.friends.act(b.id,{action:'remove',id:link.id});else{db.admin.bootstrap(c.id);const user=db.admin.users(c.id).find(u=>u.id===a.id);db.admin.updateUser(c.id,{action:'update',id:a.id,role:'participant',disabled:true,version:user.version});}
  assert.equal(db.social.unreadMessages(b.id).unread,0);await db.notifications.tick(instant);assert.equal(sent.length,0);assert.equal(db.activity.list(b.id).items.length,0);
 }finally{db.close();}}
});
test('the unread API requires a session and ignores supplied participant IDs',async()=>{
 const {db,a,b,c}=fixture();db.social.sendMessage(a.id,message(b,'api'));const tokens=new Map([b,c].map(u=>[u.id,db.createSession(u.id)])),login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 try{const url=login.origin+'/social/messages/unread?participantId='+b.id;assert.equal((await fetch(url)).status,401);const own=await fetch(url,{headers:{Cookie:tokens.get(b.id)}});assert.equal(own.headers.get('cache-control'),'no-store');assert.equal((await own.json()).unread,1);assert.equal((await (await fetch(url,{headers:{Cookie:tokens.get(c.id)}})).json()).unread,0);}finally{await new Promise(r=>server.close(r));db.close();}
});
