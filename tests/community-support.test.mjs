import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createNotifications} from '../server/notifications.mjs';
import {readFileSync,mkdtempSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
const now=Date.parse('2026-09-15T14:00:00Z');
const pref=(id,extra={})=>({subscription:{endpoint:'https://fcm.googleapis.com/fcm/send/'+id,keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}},timeZone:'UTC',quietStart:0,quietEnd:0,...extra});
const record=(id,kind='observation')=>({id,kind,occurredAt:'2026-09-01T12:00:00+00:00',...(kind==='observation'?{liquidsMl:100,liquidsMode:'interval',diaperNumber:1}:kind==='wetting'?{category:'bedwetting',position:'laying-down',diaperNumber:1}:{diaperNumber:1,wettingsCount:0})});
const change=entry=>({id:entry.id,entry,baseVersion:0,mutationId:entry.id});
function fixture(){let time=now;const delivered=[];const db=openDatabase(':memory:',{stickerCatalog:[],now:()=>time,notifications:{send:async(s,p)=>delivered.push({s,p}),random:()=>99}});const a=db.ensureParticipant('test','a','Private Alice'),b=db.ensureParticipant('test','b','Private Bob');return {db,a,b,delivered,setTime:t=>time=t,save:(id,kind)=>db.sync(a.id,[change(record(id,kind))])};}

test('new enables default on, unsubscribed accounts stay off, invalid values fail and saved opt-outs persist',()=>{
 const f=fixture();try {
  f.db.notifications.save(f.a.id,pref('a'));assert.equal(f.db.notifications.status(f.a.id).preferences.communitySupport,1);
  assert.equal(f.db.notifications.status(f.a.id).preferences.communityAnonymous,0);
  for(const communityAnonymous of [null,1,'true',{}])assert.throws(()=>f.db.notifications.save(f.a.id,pref('a',{communityAnonymous})),e=>e.status===400);
  f.db.notifications.save(f.a.id,pref('a',{communityAnonymous:true}));
  for(const value of [null,1,'true',{}])assert.throws(()=>f.db.notifications.save(f.a.id,pref('a',{communitySupport:value})),e=>e.status===400);
  f.db.notifications.save(f.a.id,pref('a',{communitySupport:false}));f.db.notifications.remove(f.a.id,{all:true});f.db.notifications.save(f.a.id,pref('new-device'));
  assert.equal(f.db.notifications.status(f.a.id).preferences.communitySupport,0);assert.equal(f.db.notifications.status(f.a.id).preferences.communityAnonymous,1);
 }finally{f.db.close();}
 const raw=new DatabaseSync(':memory:');try {
  raw.exec("CREATE TABLE participants(id TEXT PRIMARY KEY);CREATE TABLE participant_access(participant_id TEXT PRIMARY KEY,disabled INTEGER);CREATE TABLE notification_preferences(owner TEXT PRIMARY KEY,time_zone TEXT,quiet_start INTEGER,quiet_end INTEGER,admin_messages INTEGER);INSERT INTO participants VALUES ('old');INSERT INTO notification_preferences VALUES ('old','UTC',0,0,1)");
  const service=createNotifications(raw,()=>[],{send:async()=>{}});assert.equal(service.status('old').preferences.communitySupport,0);
 }finally{raw.close();}
});

test('existing subscribers enroll once on either schema version; opt-outs and disabled notifications survive reopening',()=>{
 for(const hasColumn of [false,true]) {
  const directory=mkdtempSync(resolve('artifacts/community-migration-')),file=resolve(directory,'science.sqlite');let raw=new DatabaseSync(file);
  try {
   raw.exec(`CREATE TABLE participants(id TEXT PRIMARY KEY);
    CREATE TABLE participant_access(participant_id TEXT PRIMARY KEY,disabled INTEGER);
    CREATE TABLE notification_preferences(owner TEXT PRIMARY KEY,time_zone TEXT,quiet_start INTEGER,quiet_end INTEGER,admin_messages INTEGER${hasColumn?',community_support INTEGER NOT NULL DEFAULT 0':''});
    CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,owner TEXT,payload TEXT);
    INSERT INTO participants VALUES ('subscribed'),('off');
    INSERT INTO notification_preferences(owner,time_zone,quiet_start,quiet_end,admin_messages) VALUES ('subscribed','UTC',22,8,0),('off','UTC',23,7,1);`);
   const input=pref('subscribed');raw.prepare('INSERT INTO push_subscriptions VALUES (?,?,?)').run(input.subscription.endpoint,'subscribed',JSON.stringify(input.subscription));
   let service=createNotifications(raw,()=>[],{send:async()=>{throw Error('Migration must not send a push');}});
   assert.equal(service.status('subscribed').preferences.communitySupport,1);
   assert.equal(service.status('subscribed').preferences.adminMessages,0);
   assert.equal(service.status('subscribed').preferences.quietStart,22);
   assert.equal(service.status('off').preferences.communitySupport,0);
   assert.equal(service.status('off').subscriptions,0);
   assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM community_checkins').get().n,0,'Enrollment does not backfill events');
   service.save('subscribed',{...input,communitySupport:false,communityAnonymous:true});raw.close();raw=new DatabaseSync(file);
   service=createNotifications(raw,()=>[],{send:async()=>{}});
   assert.equal(service.status('subscribed').preferences.communitySupport,0,'Restart preserves a later opt-out');
   assert.equal(service.status('subscribed').preferences.communityAnonymous,1,'Restart preserves anonymous sharing');
   assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM notification_migrations').get().n,1);
  }finally{raw.close();}
 }
});

test('failed enrollment rolls back its marker so the next startup can retry',()=>{
 const raw=new DatabaseSync(':memory:');try {
  raw.exec(`CREATE TABLE participants(id TEXT PRIMARY KEY);CREATE TABLE participant_access(participant_id TEXT PRIMARY KEY,disabled INTEGER);
   CREATE TABLE notification_preferences(owner TEXT PRIMARY KEY,time_zone TEXT,quiet_start INTEGER,quiet_end INTEGER,admin_messages INTEGER,community_support INTEGER);
   CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,owner TEXT,payload TEXT);
   INSERT INTO participants VALUES ('a');INSERT INTO notification_preferences VALUES ('a','UTC',0,0,0,0);
   INSERT INTO push_subscriptions VALUES ('fixture','a','{}');
   CREATE TRIGGER fail_enrollment BEFORE UPDATE ON notification_preferences BEGIN SELECT RAISE(FAIL,'fixture'); END;`);
  assert.throws(()=>createNotifications(raw,()=>[],{send:async()=>{}}),/fixture/);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM notification_migrations').get().n,0);
  raw.exec('DROP TRIGGER fail_enrollment');
  assert.equal(createNotifications(raw,()=>[],{send:async()=>{}}).status('a').preferences.communitySupport,1);
 }finally{raw.close();}
});

test('record sync broadcasts each new daily check-in once, to participating peers with the sender display name and no record details',async()=>{
 const f=fixture();try {
  f.db.notifications.save(f.a.id,pref('a'));f.db.notifications.save(f.b.id,pref('b'));f.db.notifications.save(f.b.id,pref('b2'));
  const outsider=f.db.ensureParticipant('test','out','Out');f.db.notifications.save(outsider.id,pref('out',{communitySupport:false}));
  f.save('first');f.save('first');f.save('extra');
  const late=f.db.ensureParticipant('test','late','Late');f.db.notifications.save(late.id,pref('late'));
  await Promise.all([f.db.notifications.tick(now),f.db.notifications.tick(now)]);await f.db.notifications.tick(now);
  assert.equal(f.delivered.length,2);assert.ok(f.delivered.every(({s})=>s.endpoint.endsWith('/b')||s.endpoint.endsWith('/b2')));
  const payload=f.delivered[0].p;assert.equal(payload.kind,'community-checkin');assert.ok(!JSON.stringify(payload).includes(f.a.id));assert.equal(payload.displayName,'Private Alice');assert.match(payload.body,/^Private Alice checked in today/);assert.ok(!JSON.stringify(payload).includes('observation'));
  for(const [day,kind]of [[1,'wetting'],[2,'diaper-change']]){f.setTime(now+day*86400000);f.save('day'+day,kind);await f.db.notifications.tick(now+day*86400000);}
  assert.equal(f.delivered.length,8);
 }finally{f.db.close();}
});

test('rolls earn and broadcast one daily check-in shared with other records; retries, edits and opt-outs cannot send extras',async()=>{
 const f=fixture();try {
  f.db.notifications.save(f.a.id,pref('a'));f.db.notifications.save(f.b.id,pref('b'));
  const roll=(id,result)=>({id,kind:'roll',occurredAt:'2026-09-01T12:00:00+00:00',rolledAt:'2026-09-01T12:00:00+00:00',source:'random',result,rolledResult:result,probability:50});
  const first=roll('first-roll','hold');
  f.db.sync(f.a.id,[change(first)]);f.db.sync(f.a.id,[change(first)]);
  f.db.sync(f.a.id,[change(roll('extra-roll','pee'))]);f.save('same-day-observation');
  await f.db.notifications.tick(now);
  assert.equal(f.delivered.length,1);assert.equal(f.db.economy.loginBonuses(f.a.id).totalDays,1);
  assert.equal(f.db.economy.loginBonuses(f.a.id).earned.coins,10);
  f.setTime(now+86400000);
  f.db.sync(f.a.id,[{...change(first),baseVersion:1,mutationId:'roll-edit',entry:{...first,position:'sitting',edited:true}}]);
  await f.db.notifications.tick(now+86400000);assert.equal(f.delivered.length,1);
  f.db.sync(f.a.id,[change(roll('tomorrow-roll','pee'))]);await f.db.notifications.tick(now+86400000);
  assert.equal(f.delivered.length,2);assert.equal(f.db.economy.loginBonuses(f.a.id).streak,2);
  assert.equal(f.db.economy.loginBonuses(f.a.id).earned.coins,30);
  f.setTime(now+2*86400000);f.save('record-first');f.db.sync(f.a.id,[change(roll('after-record','hold'))]);await f.db.notifications.tick(now+2*86400000);
  assert.equal(f.delivered.length,3,'A roll after another qualifying record shares that day\'s check-in');
  f.db.notifications.save(f.a.id,pref('a',{communitySupport:false}));f.setTime(now+3*86400000);
  f.db.sync(f.a.id,[change(roll('opted-out-roll','hold'))]);await f.db.notifications.tick(now+3*86400000);
  assert.equal(f.delivered.length,3);assert.equal(f.db.economy.loginBonuses(f.a.id).earned.diamonds,1,'Daily rewards remain available after community opt-out');
 }finally{f.db.close();}
});

test('quiet hours defer; opt-out in either direction and disabling devices cancel queued broadcasts permanently',async()=>{
 for(const action of ['sender','recipient','disable','device','expiry']){
  const f=fixture();try {
   f.db.notifications.save(f.a.id,pref('a'));f.db.notifications.save(f.b.id,pref('b',{quietStart:13,quietEnd:16}));f.save('quiet');
   await f.db.notifications.tick(now);assert.equal(f.delivered.length,0);
   if(action==='sender'){f.db.notifications.save(f.a.id,pref('a',{communitySupport:false}));f.db.notifications.save(f.a.id,pref('a',{communitySupport:true}));}
   if(action==='recipient'){f.db.notifications.save(f.b.id,pref('b',{communitySupport:false}));f.db.notifications.save(f.b.id,pref('b',{communitySupport:true}));}
   if(action==='disable'){f.db.notifications.remove(f.a.id,{all:true});f.db.notifications.save(f.a.id,pref('a'));}
   if(action==='device'){f.db.notifications.remove(f.b.id,{endpoint:pref('b').subscription.endpoint});f.db.notifications.save(f.b.id,pref('b'));}
   await f.db.notifications.tick(now+(action==='expiry'?86400000:7200000));assert.equal(f.delivered.length,0,action);
  }finally{f.db.close();}
 }
 const f=fixture();try{f.db.notifications.save(f.a.id,pref('a'));f.db.notifications.save(f.b.id,pref('b',{quietStart:13,quietEnd:16}));f.save('quiet');await f.db.notifications.tick(now);await f.db.notifications.tick(now+7200000);assert.equal(f.delivered.length,1);}finally{f.db.close();}
});

test('edits and failed batches cannot broadcast, and live disabled accounts cannot receive',async()=>{
 const f=fixture();try {
  f.db.notifications.save(f.a.id,pref('a'));f.db.notifications.save(f.b.id,pref('b'));
  assert.throws(()=>f.db.sync(f.a.id,[change(record('rollback')),{...change(record('bad')),entry:{...record('bad'),liquidsMl:-1}}]));
  await f.db.notifications.tick(now);assert.equal(f.delivered.length,0);
  f.save('first');await f.db.notifications.tick(now);f.setTime(now+86400000);
  f.db.sync(f.a.id,[{...change(record('first')),baseVersion:1,mutationId:'edit',entry:{...record('first'),liquidsMl:200}}]);await f.db.notifications.tick(now+86400000);assert.equal(f.delivered.length,1);
  f.db.admin.bootstrap(f.a.id);f.save('disabled');const user=f.db.admin.users(f.a.id).find(u=>u.id===f.b.id);f.db.admin.updateUser(f.a.id,{action:'update',id:f.b.id,role:'participant',disabled:true,version:user.version});
  await f.db.notifications.tick(now+86400000);assert.equal(f.delivered.length,1);
 }finally{f.db.close();}
});

test('durable pending check-ins survive restart; failed delivery removes expired subscriptions without replay',async()=>{
 const dir=mkdtempSync(resolve('artifacts/community-support-')),file=resolve(dir,'science.sqlite');let db;const delivered=[];
 const options={stickerCatalog:[],now:()=>now,notifications:{random:()=>99,send:async(s,p)=>{delivered.push(p);throw {statusCode:410};}}};
 try {
  db=openDatabase(file,options);const a=db.ensureParticipant('test','a','A'),b=db.ensureParticipant('test','b','B');db.notifications.save(a.id,pref('a'));db.notifications.save(b.id,pref('b'));db.sync(a.id,[change(record('first'))]);db.close();
  db=openDatabase(file,options);await db.notifications.tick(now);assert.equal(delivered.length,1);assert.equal(db.notifications.status(b.id).subscriptions,0);db.close();
  db=openDatabase(file,options);await db.notifications.tick(now);assert.equal(delivered.length,1);
 }finally{db?.close();}
});

test('sender anonymity overrides recipient preferences and protects queued notices when toggled',async()=>{
 const f=fixture();try {
  f.db.notifications.save(f.a.id,pref('a'));f.db.notifications.save(f.b.id,pref('b',{communityAnonymous:true,quietStart:13,quietEnd:16}));
  f.save('named');await f.db.notifications.tick(now+7200000);assert.equal(f.delivered[0].p.displayName,'Private Alice','Recipient anonymity does not hide other senders');
  f.setTime(now+86400000);f.save('pending-named');
  f.db.notifications.save(f.a.id,pref('a',{communityAnonymous:true}));
  f.db.notifications.save(f.a.id,pref('a',{communityAnonymous:false}));
  await f.db.notifications.tick(now+86400000+7200000);
  assert.equal(f.delivered[1].p.displayName,undefined);assert.ok(!JSON.stringify(f.delivered[1].p).includes('Private Alice'));
  f.setTime(now+2*86400000);f.db.notifications.save(f.a.id,pref('a',{communityAnonymous:true}));f.save('anonymous');
  f.db.notifications.save(f.a.id,pref('a',{communityAnonymous:false}));await f.db.notifications.tick(now+2*86400000+7200000);
  assert.equal(f.delivered[2].p.displayName,undefined,'A check-in created anonymously cannot be unmasked');
  f.setTime(now+3*86400000);f.save('named-again');await f.db.notifications.tick(now+3*86400000+7200000);assert.equal(f.delivered[3].p.displayName,'Private Alice');
 }finally{f.db.close();}
});

test('community push uses only a bounded display name in fixed copy, with anonymous fallback',async()=>{
 const handlers={},shown=[];const self={registration:{scope:'https://lidoll.dev/tracker/',showNotification:async(...args)=>shown.push(args)},addEventListener:(name,fn)=>handlers[name]=fn};
 vm.runInNewContext(readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{self,URL,Set});let work;
 handlers.push({data:{json:()=>({kind:'community-checkin',title:'Private Alice',body:'Private record'})},waitUntil:p=>work=p});await work;
 assert.equal(shown[0][0],'Community check-in');assert.match(shown[0][1].body,/Someone in the Little Log community/);assert.ok(!shown[0][1].body.includes('Private'));
 for(const [displayName,expected]of [['Alice','Alice'],['<b>Alice</b>','<b>Alice</b>'],['Alice\n\u202e','Alice'],['x'.repeat(81),'Someone in the Little Log community'],[42,'Someone in the Little Log community']]) {
  handlers.push({data:{json:()=>({kind:'community-checkin',displayName,body:'Private record',title:'Injected'})},waitUntil:p=>work=p});await work;
  assert.equal(shown.at(-1)[0],'Community check-in');assert.equal(shown.at(-1)[1].body,expected+' checked in today. A little reminder to record your day, too.');
 }
});
