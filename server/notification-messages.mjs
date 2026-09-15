import {createHash,randomUUID} from 'node:crypto';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
export function createNotificationMessages(db,{configured,send,localBlock,activity}) { // Queue admin announcements in SQLite so quiet hours and process restarts do not lose pending messages.
 db.exec(`CREATE TABLE IF NOT EXISTS notification_messages(id TEXT PRIMARY KEY,actor TEXT NOT NULL REFERENCES participants(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,participant_id TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL,UNIQUE(actor,request_id));
 CREATE TABLE IF NOT EXISTS notification_deliveries(message_id TEXT NOT NULL REFERENCES notification_messages(id),owner TEXT NOT NULL REFERENCES participants(id),endpoint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',PRIMARY KEY(message_id,endpoint));
 CREATE INDEX IF NOT EXISTS notification_delivery_state ON notification_deliveries(state);`);
 function requireAdmin(actor) { // Every privileged read and mutation checks the current role, including calls after parsing a request body.
  const access=db.prepare('SELECT role,disabled FROM participant_access WHERE participant_id=?').get(actor);
  if(access?.role!=='admin'||access.disabled)fail(403,'Administrator access is required.');
 }
 function recipients() {
  return db.prepare(`SELECT p.id,p.label,COUNT(*) AS subscriptions FROM participants p JOIN push_subscriptions s ON s.owner=p.id JOIN notification_preferences n ON n.owner=p.id WHERE n.admin_messages=1 AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.id AND a.disabled=1) GROUP BY p.id ORDER BY p.label,p.id`).all();
 }
 function history() { // Delivery results never expose subscription endpoints or encryption keys to the admin browser.
  return db.prepare(`SELECT m.id,m.actor,m.title,m.body,m.participant_id AS participantId,m.created,m.expires,COUNT(d.endpoint) AS devices,COUNT(DISTINCT d.owner) AS members,
   SUM(CASE WHEN d.state='queued' THEN 1 ELSE 0 END) AS queued,SUM(CASE WHEN d.state='accepted' THEN 1 ELSE 0 END) AS accepted,SUM(CASE WHEN d.state IN ('failed','attempted') THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN d.state='skipped' THEN 1 ELSE 0 END) AS skipped
   FROM notification_messages m LEFT JOIN notification_deliveries d ON d.message_id=m.id GROUP BY m.id ORDER BY m.created DESC,m.rowid DESC LIMIT 25`).all();
 }
 function overview(actor){requireAdmin(actor);return {configured,recipients:recipients(),messages:history()};}
 function queue(actor,input,now=Date.now()) { // One request ID creates one snapshot of opted-in recipients, making retries safe even after a lost HTTP response.
  requireAdmin(actor);
  if(!configured)fail(503,'Notifications are not configured on this server yet.');
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Provide a notification message.');
  const {requestId,participantId=''}=input;
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))fail(400,'Provide a valid message request ID.');
  if(typeof participantId!=='string'||participantId.length>100)fail(400,'Choose a valid recipient.');
  for(const [field,max]of [['title',80],['body',500]])if(typeof input[field]!=='string'||!input[field].trim()||input[field].length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input[field]))fail(400,field==='title'?'Use a title of 1 to 80 characters.':'Use a message of 1 to 500 characters.');
  const title=input.title.trim(),body=input.body.trim(),hash=createHash('sha256').update(JSON.stringify({title,body,participantId})).digest('hex');
  const existing=db.prepare('SELECT id,request_hash FROM notification_messages WHERE actor=? AND request_id=?').get(actor,requestId);
  if(existing){if(existing.request_hash!==hash)fail(409,'This request ID already belongs to a different message.');return {id:existing.id,repeated:true};}
  const selected=recipients().filter(user=>!participantId||user.id===participantId);
  if(!selected.length)fail(400,'No enabled members in this audience have opted into messages from admins.');
  const id=randomUUID();
  db.exec('BEGIN IMMEDIATE');try {
   const raced=db.prepare('SELECT id,request_hash FROM notification_messages WHERE actor=? AND request_id=?').get(actor,requestId);
   if(raced){if(raced.request_hash!==hash)fail(409,'This request ID already belongs to a different message.');db.exec('COMMIT');return {id:raced.id,repeated:true};}
   db.prepare('INSERT INTO notification_messages VALUES (?,?,?,?,?,?,?,?,?)').run(id,actor,requestId,hash,title,body,participantId||null,now,now+86400000);
   const insert=db.prepare('INSERT INTO notification_deliveries(message_id,owner,endpoint) VALUES (?,?,?)');
   for(const user of selected)for(const sub of db.prepare('SELECT endpoint FROM push_subscriptions WHERE owner=?').all(user.id))insert.run(id,user.id,sub.endpoint);
   db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),actor,'queue-notification',participantId||null,JSON.stringify({messageId:id,members:selected.length}),new Date(now).toISOString());
   db.exec('COMMIT');return {id,repeated:false};
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 function cancel(actor,input) { // Cancels unsent deliveries only; messages already accepted by a push service cannot be recalled.
  requireAdmin(actor);if(typeof input?.id!=='string')fail(400,'Choose a queued message.');
  if(!db.prepare('SELECT 1 FROM notification_messages WHERE id=?').get(input.id))fail(404,'Message not found.');
  db.exec('BEGIN IMMEDIATE');try {
   const result=db.prepare("UPDATE notification_deliveries SET state='skipped' WHERE message_id=? AND state='queued'").run(input.id);
   db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),actor,'cancel-notification',null,JSON.stringify({messageId:input.id,devices:result.changes}),new Date().toISOString());
   db.exec('COMMIT');return {cancelled:result.changes};
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 async function tick(now=Date.now()) { // Claims each device before delivery; ambiguous transport failures are never automatically resent.
  if(!configured)return;
  const rows=db.prepare("SELECT d.*,m.title,m.body,m.actor,m.expires FROM notification_deliveries d JOIN notification_messages m ON m.id=d.message_id WHERE d.state='queued' ORDER BY m.created,d.rowid").all();
  let attempts=0;const started=Date.now();
  for(const row of rows) {
   const deliveryTime=now+Date.now()-started; // Long batches still respect the current local hour and queue expiry.
   if(!db.prepare("SELECT 1 FROM notification_deliveries WHERE message_id=? AND endpoint=? AND state='queued'").get(row.message_id,row.endpoint))continue;
   const pref=db.prepare('SELECT * FROM notification_preferences WHERE owner=?').get(row.owner);
   const sub=db.prepare('SELECT payload FROM push_subscriptions WHERE owner=? AND endpoint=?').get(row.owner,row.endpoint);
   const sender=db.prepare('SELECT role,disabled FROM participant_access WHERE participant_id=?').get(row.actor);
   if(row.expires<=deliveryTime||!pref?.admin_messages||!sub||sender?.role!=='admin'||sender.disabled||db.prepare('SELECT 1 FROM participant_access WHERE participant_id=? AND disabled=1').get(row.owner)) {
    db.prepare("UPDATE notification_deliveries SET state='skipped' WHERE message_id=? AND endpoint=? AND state='queued'").run(row.message_id,row.endpoint);continue;
   }
   const {hour}=localBlock(deliveryTime,pref.time_zone),start=pref.quiet_start,end=pref.quiet_end;
   if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))continue;
   if(attempts>=100)break; // Bounds one scheduler pass while preserving the remaining recipients in the queue.
   if(!db.prepare("UPDATE notification_deliveries SET state='attempted' WHERE message_id=? AND endpoint=? AND state='queued'").run(row.message_id,row.endpoint).changes)continue;
   attempts++;
   activity?.record(row.owner,{source:'admin:'+row.message_id,kind:'admin-message',title:row.title,body:row.body,created:deliveryTime});
   try {
    await send(JSON.parse(sub.payload),{kind:'admin-message',title:row.title,body:row.body,tag:'admin-'+row.message_id});
    db.prepare("UPDATE notification_deliveries SET state='accepted' WHERE message_id=? AND endpoint=?").run(row.message_id,row.endpoint);
   }catch(error){
    db.prepare("UPDATE notification_deliveries SET state='failed' WHERE message_id=? AND endpoint=?").run(row.message_id,row.endpoint);
    if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE owner=? AND endpoint=?').run(row.owner,row.endpoint);
   }
  }
 }
 return {overview,queue,cancel,tick};
}
