import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {createNotifications,localBlock,nextReminderTime} from '../server/notifications.mjs';
import {createApi} from '../server/api.mjs';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
const now=Date.parse('2026-09-15T14:00:00Z');
const sub=id=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}});
const preference=id=>({subscription:sub(id),timeZone:'UTC',quietStart:0,quietEnd:0});
function seed(db,user) {
 const entries=[];for(let day=12;day<=15;day++)for(const hour of [8,10,12])entries.push({id:'wet-'+day+'-'+hour,kind:'wetting',occurredAt:'2026-09-'+day+'T'+String(hour).padStart(2,'0')+':00:00+00:00',category:'voluntary',position:'sitting',diaperNumber:1});
 db.sync(user.id,entries.map(entry=>({id:entry.id,entry,mutationId:entry.id,baseVersion:0})));return entries;
}

test('notification timing uses real intervals, respects offsets/DST, and skips insufficient or stale data',()=>{
 const db=openDatabase(':memory:',{stickerCatalog:[]}),user=db.ensureParticipant('test','a','A');try{
  const entries=seed(db,user);assert.equal(nextReminderTime(entries,now),now);
  assert.equal(nextReminderTime(entries,now+86400000),null);assert.equal(nextReminderTime(entries.slice(0,3),now),null);
  const equivalent=entries.map(e=>({...e,occurredAt:e.occurredAt.replace(/T(\d\d)/,(_,h)=>'T'+String(Number(h)-7).padStart(2,'0')).replace('+00:00','-07:00')}));assert.equal(nextReminderTime(equivalent,now),now);
  assert.equal(localBlock(Date.parse('2026-11-01T08:30:00Z'),'America/Los_Angeles').key,localBlock(Date.parse('2026-11-01T09:30:00Z'),'America/Los_Angeles').key);
  assert.notEqual(localBlock(Date.parse('2026-09-15T00:00:00Z'),'UTC').key,localBlock(Date.parse('2026-09-15T00:00:00Z'),'America/Los_Angeles').key);
 }finally{db.close();}
});

test('opt-in, one lottery per block, prediction window, quiet hours, account isolation, opt-out and expired endpoints',async()=>{
 let draws=0;const delivered=[];const db=openDatabase(':memory:',{stickerCatalog:[],notifications:{publicKey:'test',random:()=>{draws++;return 0;},send:async(s,p)=>{delivered.push([s,p]);}}});
 const a=db.ensureParticipant('test','a','A'),b=db.ensureParticipant('test','b','B');try{
  seed(db,a);await db.notifications.tick(now);assert.equal(draws,0,'No subscription means no lottery');
  db.notifications.save(a.id,preference('a'));
  await db.notifications.tick(now-60*60000);assert.equal(draws,1);assert.equal(delivered.length,0,'Winning blocks wait until close to the estimated time');
  await Promise.all([db.notifications.tick(now),db.notifications.tick(now)]);await db.notifications.tick(now+60000);
  assert.equal(draws,1);assert.equal(delivered.length,1);assert.match(delivered[0][1].body,/Pee NOW/);assert.equal(JSON.stringify(delivered).includes(a.id),false);
  assert.throws(()=>db.notifications.save(b.id,preference('a')),e=>e.status===409);
  db.notifications.remove(b.id,{endpoint:sub('a').endpoint});assert.equal(db.notifications.status(a.id).subscriptions,1);
  db.notifications.remove(a.id,{all:true});await db.notifications.tick(now+3*3600000);assert.equal(draws,1);
  db.notifications.save(a.id,{...preference('a'),quietStart:13,quietEnd:16});await db.notifications.tick(now);assert.equal(delivered.length,1);
  for(const endpoint of ['https://127.0.0.1/push','https://evil.example/push','https://fcm.googleapis.com.evil.example/push','http://fcm.googleapis.com/push'])assert.throws(()=>db.notifications.save(a.id,{...preference('bad'),subscription:{...sub('bad'),endpoint}}));
  assert.throws(()=>db.notifications.save(a.id,{...preference('a'),timeZone:'Invalid/Zone'}));
 }finally{db.close();}
 const gone=openDatabase(':memory:',{stickerCatalog:[],notifications:{random:()=>0,send:async()=>{throw {statusCode:410};}}});const user=gone.ensureParticipant('test','gone','Gone');try{seed(gone,user);gone.notifications.save(user.id,preference('gone'));await gone.notifications.tick(now);assert.equal(gone.notifications.status(user.id).subscriptions,0);}finally{gone.close();}
});

test('notification endpoints require session ownership and CSRF and never expose private keys',async()=>{
 const db=openDatabase(':memory:',{stickerCatalog:[],notifications:{publicKey:'public-test-key',send:async()=>{}}}),a=db.ensureParticipant('test','a','A');const token=db.createSession(a.id),login={origin:'',session:req=>db.session(req.headers.cookie)};
 const api=createApi(db,login),server=createServer((req,res)=>api(req,res,req.url.slice(1)));await new Promise(r=>server.listen(0,'127.0.0.1',r));login.origin='http://127.0.0.1:'+server.address().port;
 try {
  assert.equal((await fetch(login.origin+'/notifications')).status,401);
  const response=await fetch(login.origin+'/notifications',{headers:{Cookie:token}}),config=await response.json();assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(config.publicKey,'public-test-key');assert.equal(config.privateKey,undefined);
  const post=headers=>fetch(login.origin+'/notifications',{method:'POST',headers:{Cookie:token,Origin:login.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(preference('a'))});
  assert.equal((await post({})).status,403);assert.equal((await post({'X-CSRF-Token':config.csrf})).status,200);
 }finally{await new Promise(r=>server.close(r));db.close();}
});

test('push handler shows the approved reminder and notification clicks stay inside the app',async()=>{
 const handlers={},shown=[];let opened;const self={registration:{scope:'https://lidoll.dev/tracker/',showNotification:async(...args)=>shown.push(args)},addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>[],openWindow:async url=>{opened=url;}}};
 vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{self,URL,Set});
 let work;handlers.push({data:{json:()=>({title:'Potty check-in',body:'injected',url:'https://evil.example',tag:'potty-test'})},waitUntil:p=>{work=p;}});await work;
 assert.equal(shown[0][1].body,'Pee NOW! Time for a potty check-in.');
 assert.equal(shown[0][1].icon,'https://lidoll.dev/tracker/icons/notification-icon.png');
 assert.equal(shown[0][1].badge,'https://lidoll.dev/tracker/icons/notification-badge.png');
 handlers.notificationclick({notification:{close(){}},waitUntil:p=>{work=p;}});await work;assert.equal(opened,'https://lidoll.dev/tracker/#overview');
});


test('losing lotteries survive a scheduler restart and disabled accounts cannot receive reminders',async()=>{
 const raw=new DatabaseSync(':memory:');raw.exec("CREATE TABLE participants(id TEXT PRIMARY KEY);CREATE TABLE participant_access(participant_id TEXT PRIMARY KEY,disabled INTEGER);INSERT INTO participants VALUES ('a')");
 let draws=0;const options={random:()=>{draws++;return 1;},send:async()=>{throw Error('Must not send');}};
 try {
  let scheduler=createNotifications(raw,()=>[],options);scheduler.save('a',preference('restart'));
  await scheduler.tick(now);assert.equal(draws,1);
  scheduler=createNotifications(raw,()=>[],{...options,random:()=>{draws++;return 0;}});await scheduler.tick(now+60000);assert.equal(draws,1,'Restart must not reroll a losing block');
  raw.exec("INSERT INTO participant_access VALUES ('a',1)");await scheduler.tick(now+3*3600000);assert.equal(draws,1,'Disabled accounts skip both lotteries and notifications');
 }finally{raw.close();}
});
