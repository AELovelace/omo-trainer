import {randomUUID} from 'node:crypto';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const preferences={like:'social_likes',comment:'social_comments','friend-post':'friend_posts'};
const recordPreferences={wetting:'friend_wettings','diaper-change':'friend_changes',observation:'friend_liquids'};
export function createActivity(db,{canSee=()=>true,now=Date.now}={}) {
 db.exec(`CREATE TABLE IF NOT EXISTS activity_notifications(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL REFERENCES participants(id),source TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT,post_id TEXT,comment_id TEXT,title TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,read_at INTEGER,withdrawn INTEGER NOT NULL DEFAULT 0,UNIQUE(owner,source));
 CREATE INDEX IF NOT EXISTS activity_owner ON activity_notifications(owner,seq);
 CREATE TABLE IF NOT EXISTS activity_deliveries(notification_id TEXT NOT NULL REFERENCES activity_notifications(id),owner TEXT NOT NULL,endpoint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',PRIMARY KEY(notification_id,endpoint));
 CREATE INDEX IF NOT EXISTS activity_delivery_state ON activity_deliveries(state);`);
 const active=owner=>Boolean(db.prepare('SELECT 1 FROM participants p WHERE id=? AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.id AND a.disabled=1)').get(owner));
 const requireUser=owner=>{if(!active(owner))fail(403,'Sign in with an enabled account to view activity.');};
 const communityEnabled=owner=>Boolean(db.prepare('SELECT community_support FROM notification_preferences WHERE owner=?').get(owner)?.community_support);
 const visibleKind="(kind<>'community-checkin' OR ?=1)"; // Apply the saved Community support choice before paging, counting or marking notifications read.
 function pushEnabled(pref,kind,postId){
  if(!pref?.[preferences[kind]])return false;
  if(kind!=='friend-post'||!postId)return true;
  const record=db.prepare("SELECT json_extract(e.payload_json,'$.kind') AS kind FROM social_record_posts p JOIN entries e ON e.participant_id=p.owner AND e.id=p.entry_id WHERE p.post_id=?").get(postId);
  const column=recordPreferences[record?.kind];return !column||Boolean(pref[column]);
 } // Resolve linked records at queue and delivery time, including posts queued before these opt-outs existed.
 function record(owner,{source,kind,actor=null,postId=null,commentId=null,title='',body='',created=now()},push=false) {
  if(!active(owner)||owner===actor||(kind==='community-checkin'&&!communityEnabled(owner)))return;
  const id=randomUUID();
  if(!db.prepare('INSERT OR IGNORE INTO activity_notifications(id,owner,source,kind,actor,post_id,comment_id,title,body,created) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,owner,source,kind,actor,postId,commentId,title,body,created).changes)return;
  const pref=push?db.prepare('SELECT * FROM notification_preferences WHERE owner=?').get(owner):null;
  if(push&&pushEnabled(pref,kind,postId)) {
   for(const {endpoint} of db.prepare('SELECT endpoint FROM push_subscriptions WHERE owner=?').all(owner))db.prepare('INSERT INTO activity_deliveries(notification_id,owner,endpoint) VALUES (?,?,?)').run(id,owner,endpoint);
  }
  return id;
 } // Store one account notification independently of device delivery; retries never create duplicate history or pushes.
 function valid(row){return !row.withdrawn&&active(row.owner)&&(!row.actor||active(row.actor))&&canSee(row);}
 function withdraw(id){db.prepare('UPDATE activity_notifications SET withdrawn=1 WHERE id=?').run(id);db.prepare("UPDATE activity_deliveries SET state='skipped' WHERE notification_id=? AND state='queued'").run(id);}
 function prune(owner){for(const row of db.prepare('SELECT * FROM activity_notifications WHERE owner=? AND withdrawn=0').all(owner))if(!valid(row))withdraw(row.id);}
 function payload(row) {
  if(!preferences[row.kind])return {title:row.title,body:row.body};
  const label=String(db.prepare('SELECT label FROM participants WHERE id=?').get(row.actor)?.label??'A member').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,80)||'A member';
  return {title:row.kind==='like'?'New like':row.kind==='comment'?'New comment':'A friend posted',body:label+(row.kind==='like'?' liked your post.':row.kind==='comment'?' commented on your post.':' shared a new post.')};
 } // Social pushes contain an actor name and action, never private post text or pictures.
 function list(owner,{before}={}) {
  requireUser(owner);const cursor=before===undefined||before===null?Number.MAX_SAFE_INTEGER:Number(before);if(!Number.isSafeInteger(cursor)||cursor<1)fail(400,'Invalid activity page.');prune(owner);
  const showCommunity=Number(communityEnabled(owner));
  const rows=db.prepare('SELECT * FROM activity_notifications WHERE owner=? AND withdrawn=0 AND '+visibleKind+' AND seq<? ORDER BY seq DESC LIMIT 31').all(owner,showCommunity,cursor);
  const unread=db.prepare('SELECT COUNT(*) AS n FROM activity_notifications WHERE owner=? AND withdrawn=0 AND '+visibleKind+' AND read_at IS NULL').get(owner,showCommunity).n;
  return {items:rows.slice(0,30).map(row=>({id:row.id,seq:row.seq,kind:row.kind,postId:row.post_id,created:row.created,read:Boolean(row.read_at),...payload(row)})),unread,nextBefore:rows.length>30?rows[29].seq:null,latest:db.prepare('SELECT MAX(seq) AS seq FROM activity_notifications WHERE owner=? AND withdrawn=0 AND '+visibleKind).get(owner,showCommunity).seq??null};
 }
 function read(owner,input) {
  requireUser(owner);const showCommunity=Number(communityEnabled(owner));
  if(input?.id){if(typeof input.id!=='string')fail(400,'Choose a notification.');db.prepare('UPDATE activity_notifications SET read_at=COALESCE(read_at,?) WHERE owner=? AND id=? AND withdrawn=0 AND '+visibleKind).run(now(),owner,input.id,showCommunity);}
  else {const seq=input?.through;if(!Number.isSafeInteger(seq)||!db.prepare('SELECT 1 FROM activity_notifications WHERE owner=? AND seq=? AND withdrawn=0 AND '+visibleKind).get(owner,seq,showCommunity))fail(400,'Refresh activity before marking it read.');db.prepare('UPDATE activity_notifications SET read_at=COALESCE(read_at,?) WHERE owner=? AND seq<=? AND withdrawn=0 AND '+visibleKind).run(now(),owner,seq,showCommunity);}
  return {read:true};
 } // Read changes are owner-scoped; mark-all uses the last loaded cursor so newly arriving notifications remain unread.
 function cancel(owner) {
  const pref=db.prepare('SELECT * FROM notification_preferences WHERE owner=?').get(owner);
  for(const row of db.prepare("SELECT d.*,n.kind,n.post_id FROM activity_deliveries d JOIN activity_notifications n ON n.id=d.notification_id WHERE d.owner=? AND d.state='queued'").all(owner)) {
   if(!pushEnabled(pref,row.kind,row.post_id)||!db.prepare('SELECT 1 FROM push_subscriptions WHERE owner=? AND endpoint=?').get(owner,row.endpoint))db.prepare("UPDATE activity_deliveries SET state='skipped' WHERE notification_id=? AND endpoint=?").run(row.notification_id,row.endpoint);
  }
 } // Opting out or removing a device permanently cancels its pending pushes, while stored activity remains available.
 async function tick(instant,{send,localBlock}) {
  const started=Date.now();let attempts=0;
  const rows=db.prepare("SELECT d.endpoint,n.* FROM activity_deliveries d JOIN activity_notifications n ON n.id=d.notification_id WHERE d.state='queued' ORDER BY n.seq,d.rowid").all();
  for(const row of rows) {
   const time=instant+Date.now()-started;if(!db.prepare("SELECT 1 FROM activity_deliveries WHERE notification_id=? AND endpoint=? AND state='queued'").get(row.id,row.endpoint))continue;
   const sub=db.prepare('SELECT payload FROM push_subscriptions WHERE owner=? AND endpoint=?').get(row.owner,row.endpoint),pref=db.prepare('SELECT * FROM notification_preferences WHERE owner=?').get(row.owner);
   if(!valid(row)){withdraw(row.id);continue;}
   if(row.created+86400000<=time||!sub||!pushEnabled(pref,row.kind,row.post_id)){db.prepare("UPDATE activity_deliveries SET state='skipped' WHERE notification_id=? AND endpoint=?").run(row.id,row.endpoint);continue;}
   const {hour}=localBlock(time,pref.time_zone),start=pref.quiet_start,end=pref.quiet_end;if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))continue;
   if(attempts>=100)break;
   if(!db.prepare("UPDATE activity_deliveries SET state='attempted' WHERE notification_id=? AND endpoint=? AND state='queued'").run(row.id,row.endpoint).changes)continue;attempts++;
   try{await send(JSON.parse(sub.payload),{kind:'social-activity',...payload(row),tag:'activity-'+row.id});db.prepare("UPDATE activity_deliveries SET state='accepted' WHERE notification_id=? AND endpoint=?").run(row.id,row.endpoint);}
   catch(error){db.prepare("UPDATE activity_deliveries SET state='failed' WHERE notification_id=? AND endpoint=?").run(row.id,row.endpoint);if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE owner=? AND endpoint=?').run(row.owner,row.endpoint);}
  }
 } // Quiet hours, live audience checks, expiry and claims happen before network work; ambiguous failures are not retried.
 return {record,list,read,cancel,tick,prune,withdraw};
}
