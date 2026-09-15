import {randomUUID} from 'node:crypto';

export function createCommunitySupport(db,{configured,send,localBlock}) {
 db.exec(`CREATE TABLE IF NOT EXISTS community_checkins(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES participants(id),day TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,UNIQUE(owner,day));
 CREATE TABLE IF NOT EXISTS community_deliveries(event_id TEXT NOT NULL REFERENCES community_checkins(id),owner TEXT NOT NULL REFERENCES participants(id),endpoint TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'queued',PRIMARY KEY(event_id,endpoint));
 CREATE INDEX IF NOT EXISTS community_delivery_state ON community_deliveries(state);`);
 if(!db.prepare('PRAGMA table_info(community_checkins)').all().some(column=>column.name==='anonymous'))db.exec('ALTER TABLE community_checkins ADD COLUMN anonymous INTEGER NOT NULL DEFAULT 1'); // Already queued check-ins keep the anonymous wording promised when they were saved.
 const enabled=owner=>Boolean(db.prepare(`SELECT 1 FROM notification_preferences p WHERE p.owner=? AND p.community_support=1
  AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.owner=p.owner)
  AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.owner AND a.disabled=1)`).get(owner)); // Sharing and receiving both require a current subscription and enabled account.
 function queue(owner,checkin) {
  if(!configured||!checkin||!enabled(owner))return;
  const id=randomUUID();
  const anonymous=db.prepare('SELECT community_anonymous FROM notification_preferences WHERE owner=?').get(owner).community_anonymous;
  if(!db.prepare('INSERT OR IGNORE INTO community_checkins(id,owner,day,created,expires,anonymous) VALUES (?,?,?,?,?,?)').run(id,owner,checkin.day,checkin.instant,checkin.instant+86400000,anonymous).changes)return;
  db.prepare(`INSERT INTO community_deliveries(event_id,owner,endpoint)
   SELECT ?,s.owner,s.endpoint FROM push_subscriptions s JOIN notification_preferences p ON p.owner=s.owner
   WHERE s.owner<>? AND p.community_support=1 AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=s.owner AND a.disabled=1)`).run(id,owner);
 } // Runs inside the record transaction: one new daily receipt snapshots participating devices, with no network work.
 function anonymize(owner) {
  db.prepare("UPDATE community_checkins SET anonymous=1 WHERE owner=? AND EXISTS(SELECT 1 FROM community_deliveries d WHERE d.event_id=community_checkins.id AND d.state='queued')").run(owner);
 } // Apply a new privacy choice to unsent check-ins; switching back later cannot reveal those older events.
 function cancel(owner) {
  db.prepare(`UPDATE community_deliveries SET state='skipped' WHERE state='queued' AND
   (owner=? OR event_id IN (SELECT id FROM community_checkins WHERE owner=?))`).run(owner,owner);
 } // Opting out cancels pending broadcasts in both directions, even if the user later opts back in.
 function remove(owner) {
  db.prepare(`UPDATE community_deliveries SET state='skipped' WHERE state='queued' AND owner=?
   AND NOT EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.owner=community_deliveries.owner AND s.endpoint=community_deliveries.endpoint)`).run(owner);
  if(!enabled(owner))cancel(owner);
 } // A removed endpoint cannot regain old deliveries when subscribed again.
 async function tick(now=Date.now()) {
  if(!configured)return;
  const started=Date.now();let attempts=0;
  const rows=db.prepare(`SELECT d.*,c.owner AS sender,c.expires FROM community_deliveries d JOIN community_checkins c ON c.id=d.event_id WHERE d.state='queued' ORDER BY c.created,d.rowid`).all();
  for(const row of rows) {
   const instant=now+Date.now()-started;
   if(!db.prepare("SELECT 1 FROM community_deliveries WHERE event_id=? AND endpoint=? AND state='queued'").get(row.event_id,row.endpoint))continue;
   const sub=db.prepare('SELECT payload FROM push_subscriptions WHERE owner=? AND endpoint=?').get(row.owner,row.endpoint);
   if(row.expires<=instant||!sub||!enabled(row.sender)||!enabled(row.owner)) {
    db.prepare("UPDATE community_deliveries SET state='skipped' WHERE event_id=? AND endpoint=? AND state='queued'").run(row.event_id,row.endpoint);continue;
   }
   const pref=db.prepare('SELECT * FROM notification_preferences WHERE owner=?').get(row.owner);
   const {hour}=localBlock(instant,pref.time_zone),start=pref.quiet_start,end=pref.quiet_end;
   if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))continue;
   if(attempts>=100)break;
   if(!db.prepare("UPDATE community_deliveries SET state='attempted' WHERE event_id=? AND endpoint=? AND state='queued'").run(row.event_id,row.endpoint).changes)continue;
   attempts++;
   const sender=db.prepare('SELECT p.label,n.community_anonymous FROM participants p JOIN notification_preferences n ON n.owner=p.id WHERE p.id=?').get(row.sender);
   const event=db.prepare('SELECT anonymous FROM community_checkins WHERE id=?').get(row.event_id);
   const displayName=event.anonymous||sender.community_anonymous?'':String(sender.label).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,80); // Only the sender controls anonymity; names come from the saved account, never record input.
   const body=(displayName||'Someone in the Little Log community')+' checked in today. A little reminder to record your day, too.';
   try {
    await send(JSON.parse(sub.payload),{kind:'community-checkin',title:'Community check-in',body,...(displayName?{displayName}:{}),tag:'community-'+row.event_id});
    db.prepare("UPDATE community_deliveries SET state='accepted' WHERE event_id=? AND endpoint=?").run(row.event_id,row.endpoint);
   }catch(error) {
    db.prepare("UPDATE community_deliveries SET state='failed' WHERE event_id=? AND endpoint=?").run(row.event_id,row.endpoint);
    if([404,410].includes(error.statusCode))db.prepare('DELETE FROM push_subscriptions WHERE owner=? AND endpoint=?').run(row.owner,row.endpoint);
   }
  }
 } // Quiet hours defer up to 24 hours; claim before sending so uncertain transport results never cause duplicate pushes.
 return {queue,cancel,remove,tick,anonymize};
}
