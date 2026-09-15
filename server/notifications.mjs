import webpush from 'web-push';
import {createCommunitySupport} from './community-support.mjs';
import {createNotificationMessages} from './notification-messages.mjs';
import {randomInt} from 'node:crypto';
import {preparePredictionData} from '../lib/prediction.js';
const MINUTE=60000;
function fail(message){throw Object.assign(Error(message),{status:400});}
export function localBlock(now,timeZone) { // IANA zones follow DST; repeated fall-back hours share one block lottery.
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
 const part=name=>parts.find(p=>p.type===name).value,hour=Number(part('hour'));
 return {key:part('year')+'-'+part('month')+'-'+part('day')+':'+Math.floor(hour/3),hour};
}
export function nextReminderTime(entries,now) { // Actual-wetting intervals use absolute timestamps; the browser separately supplies its IANA zone.
 const data=preparePredictionData(entries,now);
 if(data.intervals.length<8||new Set(data.intervals.map(i=>i.day)).size<3||data.lastWetting===null||now-data.lastWetting>480*MINUTE)return null;
 return data.lastWetting+data.intervals.reduce((sum,i)=>sum+i.duration,0)/data.intervals.length*MINUTE;
}
function subscription(value) { // Restrict outbound requests to known browser push services, excluding arbitrary/private SSRF endpoints.
 let url;try{url=new URL(value?.endpoint);}catch{fail('Invalid push subscription.');}
 const host=url.hostname,allowed=['fcm.googleapis.com','web.push.apple.com','updates.push.services.mozilla.com'].includes(host)||host.endsWith('.push.services.mozilla.com')||host.endsWith('.notify.windows.com');
 if(!allowed||url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.href.length>2048)fail('Unsupported push service.');
 for(const [key,size]of [['p256dh',65],['auth',16]])if(typeof value.keys?.[key]!=='string'||!/^[-_A-Za-z0-9]+$/.test(value.keys[key])||Buffer.from(value.keys[key],'base64url').length!==size)fail('Invalid push encryption keys.');
 return {endpoint:url.href,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
}
export function createNotifications(db,records,options={}) { // Subscriptions and decisions stay in the scientific database, separate from the market.
 db.exec(`CREATE TABLE IF NOT EXISTS notification_preferences(owner TEXT PRIMARY KEY REFERENCES participants(id),time_zone TEXT NOT NULL,quiet_start INTEGER NOT NULL,quiet_end INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES participants(id),payload TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS push_owner ON push_subscriptions(owner);
 CREATE TABLE IF NOT EXISTS notification_blocks(owner TEXT NOT NULL REFERENCES participants(id),block TEXT NOT NULL,selected INTEGER NOT NULL,sent INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,PRIMARY KEY(owner,block));`);
 if(!db.prepare('PRAGMA table_info(notification_preferences)').all().some(column=>column.name==='admin_messages'))db.exec('ALTER TABLE notification_preferences ADD COLUMN admin_messages INTEGER NOT NULL DEFAULT 0'); // Existing reminder-only subscriptions do not silently opt into announcements.
 if(!db.prepare('PRAGMA table_info(notification_preferences)').all().some(column=>column.name==='community_support'))db.exec('ALTER TABLE notification_preferences ADD COLUMN community_support INTEGER NOT NULL DEFAULT 0');
 if(!db.prepare('PRAGMA table_info(notification_preferences)').all().some(column=>column.name==='community_anonymous'))db.exec('ALTER TABLE notification_preferences ADD COLUMN community_anonymous INTEGER NOT NULL DEFAULT 0'); // Display names are the default; anonymous sharing is an explicit account preference.
 if(!db.prepare('PRAGMA table_info(notification_preferences)').all().some(c=>c.name==='community_friends_only'))db.exec('ALTER TABLE notification_preferences ADD COLUMN community_friends_only INTEGER NOT NULL DEFAULT 0'); // Friends-only is optional and never enables sharing by itself.
 db.exec('CREATE TABLE IF NOT EXISTS notification_migrations(name TEXT PRIMARY KEY)');
 db.exec('BEGIN IMMEDIATE');try {
  if(db.prepare("INSERT OR IGNORE INTO notification_migrations VALUES ('community-support-existing-subscribers-v1')").run().changes) {
   db.exec(`UPDATE notification_preferences SET community_support=1
    WHERE EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.owner=notification_preferences.owner)`);
  }
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;} // Apply enrollment once, atomically with its marker; later restarts must preserve saved opt-outs.
 const publicKey=options.publicKey??process.env.PUSH_VAPID_PUBLIC_KEY??'';
 const vapidDetails={subject:process.env.PUSH_VAPID_SUBJECT,publicKey,privateKey:process.env.PUSH_VAPID_PRIVATE_KEY};
 const configured=Boolean(options.send||(publicKey&&vapidDetails.privateKey&&vapidDetails.subject));
 const send=options.send??((sub,payload)=>webpush.sendNotification(sub,JSON.stringify(payload),{vapidDetails,TTL:60,urgency:'normal',timeout:5000}));
 const messages=createNotificationMessages(db,{configured,send,localBlock});
 const community=createCommunitySupport(db,{configured,send,localBlock,areFriends:options.areFriends});
 const random=options.random??(()=>randomInt(100));let running=false;
 function status(owner) {
  const pref=db.prepare('SELECT time_zone AS timeZone,quiet_start AS quietStart,quiet_end AS quietEnd,admin_messages AS adminMessages,community_support AS communitySupport,community_anonymous AS communityAnonymous,community_friends_only AS communityFriendsOnly FROM notification_preferences WHERE owner=?').get(owner);
  return {configured,publicKey:configured?publicKey:'',preferences:pref??null,subscriptions:db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner=?').get(owner).n};
 }
 function save(owner,input) { // Authenticated opt-in registers only this user's endpoint and local-time preferences.
  if(!configured)throw Object.assign(Error('Notifications are not configured on this server yet.'),{status:503});
  const sub=subscription(input.subscription),timeZone=input.timeZone;
  if(typeof timeZone!=='string'||timeZone.length>100)fail('Choose a valid timezone.');try{localBlock(Date.now(),timeZone);}catch{fail('Choose a valid timezone.');}
  const {quietStart,quietEnd}=input;for(const value of [quietStart,quietEnd])if(!Number.isInteger(value)||value<0||value>23)fail('Quiet hours must be whole hours from 0 to 23.');
  const adminMessages=input.adminMessages??Boolean(db.prepare('SELECT admin_messages FROM notification_preferences WHERE owner=?').get(owner)?.admin_messages);
  if(typeof adminMessages!=='boolean')fail('Choose whether to receive messages from admins.');
  const savedPreferences=db.prepare('SELECT community_support,community_anonymous,community_friends_only FROM notification_preferences WHERE owner=?').get(owner);
  const communitySupport=input.communitySupport===undefined?(savedPreferences?Boolean(savedPreferences.community_support):true):input.communitySupport;
  if(typeof communitySupport!=='boolean')fail('Choose whether to participate in community support.');
  const communityAnonymous=input.communityAnonymous===undefined?Boolean(savedPreferences?.community_anonymous):input.communityAnonymous;
  if(typeof communityAnonymous!=='boolean')fail('Choose whether to share community check-ins anonymously.');
  const communityFriendsOnly=input.communityFriendsOnly===undefined?Boolean(savedPreferences?.community_friends_only):input.communityFriendsOnly;
  if(typeof communityFriendsOnly!=='boolean')fail('Choose whether community support is friends-only.');
  const previous=db.prepare('SELECT owner FROM push_subscriptions WHERE endpoint=?').get(sub.endpoint);
  if(previous&&previous.owner!==owner)throw Object.assign(Error('This browser is subscribed to another account. Turn off its notifications before switching accounts.'),{status:409});
  db.exec('BEGIN IMMEDIATE');try {
   if(!previous&&db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE owner=?').get(owner).n>=10)fail('At most 10 devices can receive notifications.');
   db.prepare('INSERT INTO notification_preferences(owner,time_zone,quiet_start,quiet_end,admin_messages,community_support,community_anonymous,community_friends_only) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET time_zone=excluded.time_zone,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,admin_messages=excluded.admin_messages,community_support=excluded.community_support,community_anonymous=excluded.community_anonymous,community_friends_only=excluded.community_friends_only').run(owner,timeZone,quietStart,quietEnd,Number(adminMessages),Number(communitySupport),Number(communityAnonymous),Number(communityFriendsOnly));
   if(communityFriendsOnly)community.restrict(owner);
   if(communityAnonymous)community.anonymize(owner);
   if(!communitySupport)community.cancel(owner);
   db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET payload=excluded.payload').run(sub.endpoint,owner,JSON.stringify(sub));if(!adminMessages)db.prepare("UPDATE notification_deliveries SET state='skipped' WHERE owner=? AND state='queued'").run(owner);db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return status(owner);
 }
 function remove(owner,input) { // Cancel unsent reminders when deliberately disabling notifications for all devices.
  if(input.all===true){db.prepare('DELETE FROM push_subscriptions WHERE owner=?').run(owner);db.prepare('UPDATE notification_blocks SET sent=1 WHERE owner=?').run(owner);}
  else if(typeof input.endpoint==='string')db.prepare('DELETE FROM push_subscriptions WHERE owner=? AND endpoint=?').run(owner,input.endpoint);
  else fail('Choose a device to disable.');
  db.prepare("UPDATE notification_deliveries SET state='skipped' WHERE owner=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.owner=notification_deliveries.owner AND s.endpoint=notification_deliveries.endpoint)").run(owner);community.remove(owner);return status(owner);
 }
 async function tick(now=Date.now()) { // Persist one 1% draw per user/block, surviving restarts; stale windows never produce catch-up notifications.
  if(!configured||running)return;running=true;const started=Date.now();
  try {
   const users=db.prepare('SELECT p.* FROM notification_preferences p WHERE EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.owner=p.owner) AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.owner AND a.disabled=1)').all();
   for(const pref of users) {
    const {key,hour}=localBlock(now,pref.time_zone),start=pref.quiet_start,end=pref.quiet_end;
    if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))continue;
    if(!db.prepare('SELECT 1 FROM notification_blocks WHERE owner=? AND block=?').get(pref.owner,key))db.prepare('INSERT OR IGNORE INTO notification_blocks(owner,block,selected,created_at) VALUES (?,?,?,?)').run(pref.owner,key,Number(random()===0),now);
    const decision=db.prepare('SELECT selected,sent FROM notification_blocks WHERE owner=? AND block=?').get(pref.owner,key);
    if(!decision.selected||decision.sent)continue;
    const due=nextReminderTime(records(pref.owner).flatMap(r=>r.entry?[r.entry]:[]),now);
    if(due===null||now<due-15*MINUTE||now>due+15*MINUTE)continue;
    if(!db.prepare('UPDATE notification_blocks SET sent=1 WHERE owner=? AND block=? AND sent=0').run(pref.owner,key).changes)continue;
    const payload={title:'Potty check-in',body:'Pee NOW! Time for a potty check-in.',tag:'potty-'+key};
    for(const row of db.prepare('SELECT endpoint,payload FROM push_subscriptions WHERE owner=?').all(pref.owner)) {
     if(!db.prepare('SELECT 1 FROM push_subscriptions WHERE owner=? AND endpoint=?').get(pref.owner,row.endpoint)||db.prepare('SELECT 1 FROM participant_access WHERE participant_id=? AND disabled=1').get(pref.owner))continue;
     try{await send(JSON.parse(row.payload),payload);}catch(error){if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE owner=? AND endpoint=?').run(pref.owner,row.endpoint);}
    }
   }
   await messages.tick(now+Date.now()-started);
   await community.tick(now+Date.now()-started);
   db.prepare('DELETE FROM notification_blocks WHERE created_at<?').run(now-90*86400000);
  }finally{running=false;}
 }
 return {status,save,remove,tick,messages,community};
}
