import {randomUUID} from 'node:crypto';

const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const key=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(value))fail(400,'Choose a valid friend or record.');return value;};
export function createFriends(db,recordFromRow,{onRemove=()=>{}}={}) {
 db.exec(`CREATE TABLE IF NOT EXISTS friendships(id TEXT PRIMARY KEY,a TEXT NOT NULL REFERENCES participants(id),b TEXT NOT NULL REFERENCES participants(id),requester TEXT NOT NULL REFERENCES participants(id),state TEXT NOT NULL CHECK(state IN ('pending','accepted')),created INTEGER NOT NULL,UNIQUE(a,b),CHECK(a<b));
 CREATE INDEX IF NOT EXISTS friends_b ON friendships(b);
 CREATE TABLE IF NOT EXISTS friend_record_shares(id TEXT PRIMARY KEY,friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,owner TEXT NOT NULL,recipient TEXT NOT NULL REFERENCES participants(id),record_id TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(owner,recipient,record_id),FOREIGN KEY(owner,record_id) REFERENCES entries(participant_id,id));
 CREATE INDEX IF NOT EXISTS shares_recipient ON friend_record_shares(recipient,created);
 CREATE TRIGGER IF NOT EXISTS revoke_deleted_friend_records AFTER UPDATE OF deleted_at ON entries WHEN NEW.deleted_at IS NOT NULL
 BEGIN DELETE FROM friend_record_shares WHERE owner=NEW.participant_id AND record_id=NEW.id; END;`); // Admin deletions and participant sync both revoke grants, even if the record is later restored.
 const active=id=>Boolean(db.prepare('SELECT 1 FROM participants p WHERE p.id=? AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.id AND a.disabled=1)').get(id));
 const requireUser=id=>{if(!active(id))fail(403,'This account is not available.');};
 const pair=(a,b)=>db.prepare('SELECT * FROM friendships WHERE a=? AND b=?').get(...[a,b].sort());
 const accepted=(a,b)=>Boolean(a!==b&&active(a)&&active(b)&&pair(a,b)?.state==='accepted');
 function transaction(work) {db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}} // Relationship changes and access revocation commit together.
 function list(owner) {
  requireUser(owner);
  return db.prepare(`SELECT f.id,f.state,f.requester,p.id AS participantId,p.label FROM friendships f JOIN participants p ON p.id=CASE WHEN f.a=? THEN f.b ELSE f.a END
   WHERE (f.a=? OR f.b=?) AND NOT EXISTS(SELECT 1 FROM participant_access x WHERE x.participant_id=p.id AND x.disabled=1) ORDER BY f.state,f.created DESC,f.id`).all(owner,owner,owner)
   .map(({requester,...row})=>({...row,direction:requester===owner?'outgoing':'incoming'}));
 } // The private list contains only this account's requests and accepted friends.
 function search(owner,query) {
  requireUser(owner);if(typeof query!=='string'||query.trim().length<2||query.trim().length>80)fail(400,'Enter 2 to 80 characters of a display name.');
  const term=query.trim().replace(/[\\%_]/g,'\\$&');
  return db.prepare(`SELECT p.id AS participantId,p.label FROM participants p WHERE p.id<>? AND p.label LIKE ? ESCAPE '\\'
   AND NOT EXISTS(SELECT 1 FROM participant_access x WHERE x.participant_id=p.id AND x.disabled=1) ORDER BY p.label,p.id LIMIT 20`).all(owner,'%'+term+'%').map(row=>{
    const link=pair(owner,row.participantId);return {...row,state:link?.state??'none',direction:link?.requester===owner?'outgoing':'incoming'};
   });
 } // Signed-in name search is bounded and never returns account credentials, contact details or records.
 function act(owner,input) {
  requireUser(owner);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Choose a friend action.');
  return transaction(()=>{
   if(input.action==='request') {
    const other=key(input.participantId);if(other===owner||!active(other))fail(404,'Member not found.');
    const existing=pair(owner,other);if(existing)return {id:existing.id,state:existing.state};
    for(const user of [owner,other])if(db.prepare('SELECT COUNT(*) AS n FROM friendships WHERE a=? OR b=?').get(user,user).n>=200)fail(409,'This friends list has reached its limit. Remove old requests before adding more.');
    const id=randomUUID();db.prepare("INSERT INTO friendships VALUES (?,?,?,?,'pending',?)").run(id,...[owner,other].sort(),owner,Date.now());return {id,state:'pending'};
   }
   if(!['accept','remove'].includes(input.action))fail(400,'Choose a valid friend action.');
   const row=db.prepare('SELECT * FROM friendships WHERE id=? AND (a=? OR b=?)').get(key(input.id),owner,owner);
   if(!row)fail(404,'Friend request not found.');
   const other=row.a===owner?row.b:row.a;
   if(input.action==='accept') {
    if(row.requester===owner||!active(other))fail(403,'Only the recipient can accept this request.');
    db.prepare("UPDATE friendships SET state='accepted' WHERE id=?").run(row.id);return {id:row.id,state:'accepted'};
   }
   db.prepare('DELETE FROM friend_record_shares WHERE friendship_id=?').run(row.id);
   db.prepare('DELETE FROM friendships WHERE id=?').run(row.id);onRemove(owner,other);return {removed:true};
  });
 } // Only participants in a request can accept, decline, cancel or remove it; re-friending never restores old shares.
 function record(owner,id) {
  requireUser(owner);const row=db.prepare('SELECT * FROM entries WHERE participant_id=? AND id=? AND deleted_at IS NULL').get(owner,key(id));
  if(!row)fail(404,'Sync this record before sharing it.');const value=recordFromRow(row);
  if(value.entry?.kind==='protocol')fail(400,'Enrollment settings cannot be shared.');return value;
 }
 function share(owner,input) {
  requireUser(owner);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Choose a record and friend.');
  return transaction(()=>{
   const recipient=key(input.participantId),recordId=key(input.recordId);
   if(!accepted(owner,recipient))fail(403,'Accept a friend request before sharing records.');
   const saved=record(owner,recordId);if(input.version!==saved.version)fail(409,'This record changed. Reopen the preview before sharing.');
   const link=pair(owner,recipient),id=randomUUID();
   db.prepare('INSERT OR IGNORE INTO friend_record_shares VALUES (?,?,?,?,?,?)').run(id,link.id,owner,recipient,recordId,Date.now());
   return {id:db.prepare('SELECT id FROM friend_record_shares WHERE owner=? AND recipient=? AND record_id=?').get(owner,recipient,recordId).id};
  });
 } // The owner approves a server preview version; a friend receives read-only access to this record, never the timeline.
 function unshare(owner,id) {requireUser(owner);db.prepare('DELETE FROM friend_record_shares WHERE id=? AND owner=?').run(key(id),owner);return {removed:true};}
 function shared(owner,{direction='incoming',offset=0}={}) {
  requireUser(owner);if(!['incoming','outgoing'].includes(direction)||!Number.isSafeInteger(offset)||offset<0||offset>100000)fail(400,'Choose a valid shared-record page.');
  const column=direction==='incoming'?'recipient':'owner',peer=direction==='incoming'?'owner':'recipient';
  const rows=db.prepare(`SELECT s.id AS share_id,s.created,p.id AS peer_id,p.label,e.* FROM friend_record_shares s
   JOIN friendships f ON f.id=s.friendship_id AND f.state='accepted' JOIN participants p ON p.id=s.${peer}
   JOIN entries e ON e.participant_id=s.owner AND e.id=s.record_id AND e.deleted_at IS NULL
   WHERE s.${column}=? AND NOT EXISTS(SELECT 1 FROM participant_access x WHERE x.participant_id=p.id AND x.disabled=1)
   ORDER BY s.created DESC,s.id LIMIT 51 OFFSET ?`).all(owner,offset);
  return {items:rows.slice(0,50).map(row=>({id:row.share_id,created:row.created,friend:{id:row.peer_id,label:row.label},record:recordFromRow(row)})),nextOffset:rows.length>50?offset+50:null};
 } // Recheck the friendship, both accounts and source deletion on each uncached read; recipients cannot edit shared records.
 function revokeRecord(owner,id){db.prepare('DELETE FROM friend_record_shares WHERE owner=? AND record_id=?').run(owner,id);} // Called in record deletion transactions so restoring a record cannot restore sharing.
 return {list,search,act,accepted,record,share,unshare,shared,revokeRecord};
}
