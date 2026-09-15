import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=value=>{if(typeof value!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(value))fail(400,'Invalid post, friend or request.');return value;};
const text=(value,max,optional=false)=>{if(typeof value!=='string'||value.length>max||(!optional&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail(400,`Use ${optional?'up to':'1 to'} ${max} characters.`);return value.trim();};
const cursor=value=>{if(value===undefined||value===null||value==='')return Number.MAX_SAFE_INTEGER;const n=Number(value);if(!Number.isSafeInteger(n)||n<1)fail(400,'Invalid page cursor.');return n;};
export function createSocial(db,friends,{now=Date.now,activity}={}) {
 db.exec(`CREATE TABLE IF NOT EXISTS social_posts(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL REFERENCES participants(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,audience TEXT NOT NULL CHECK(audience IN ('friends','public')),created INTEGER NOT NULL,deleted INTEGER,UNIQUE(owner,request_id));
 CREATE INDEX IF NOT EXISTS social_post_owner ON social_posts(owner,seq);
 CREATE TABLE IF NOT EXISTS social_pictures(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES social_posts(id),position INTEGER NOT NULL,alt TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,data BLOB NOT NULL);
 CREATE INDEX IF NOT EXISTS social_picture_post ON social_pictures(post_id,position);
 CREATE TABLE IF NOT EXISTS friend_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,sender TEXT NOT NULL REFERENCES participants(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,deleted INTEGER,UNIQUE(sender,request_id));
 CREATE TABLE IF NOT EXISTS friend_message_receipts(sender TEXT NOT NULL REFERENCES participants(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,friendship_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(sender,request_id));
 CREATE INDEX IF NOT EXISTS friend_message_thread ON friend_messages(friendship_id,seq);
 CREATE TABLE IF NOT EXISTS friend_message_reads(friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,owner TEXT NOT NULL REFERENCES participants(id),seq INTEGER NOT NULL,PRIMARY KEY(friendship_id,owner));`);
 db.exec(`CREATE TABLE IF NOT EXISTS social_likes(post_id TEXT NOT NULL REFERENCES social_posts(id),owner TEXT NOT NULL REFERENCES participants(id),created INTEGER NOT NULL,PRIMARY KEY(post_id,owner));
 CREATE TABLE IF NOT EXISTS social_comments(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,post_id TEXT NOT NULL REFERENCES social_posts(id),owner TEXT NOT NULL REFERENCES participants(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,deleted INTEGER,UNIQUE(owner,request_id));
 CREATE INDEX IF NOT EXISTS social_comment_post ON social_comments(post_id,seq);
 CREATE TABLE IF NOT EXISTS social_reports(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,reporter TEXT NOT NULL REFERENCES participants(id),kind TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'open',resolution TEXT,UNIQUE(reporter,kind,target));
 CREATE TABLE IF NOT EXISTS social_restrictions(owner TEXT PRIMARY KEY REFERENCES participants(id),reason TEXT NOT NULL,actor TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS social_profiles(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL UNIQUE REFERENCES participants(id),version TEXT NOT NULL,request_hash TEXT NOT NULL,data BLOB,updated INTEGER NOT NULL);`);
 const active=owner=>Boolean(db.prepare('SELECT 1 FROM participants p WHERE p.id=? AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=p.id AND a.disabled=1)').get(owner));
 const requireUser=owner=>{if(!active(owner))fail(403,'This account is not available.');};
 const requireContributor=owner=>{requireUser(owner);if(db.prepare('SELECT 1 FROM social_restrictions WHERE owner=?').get(owner))fail(403,'Social posting and messaging are paused for this account. Contact an administrator.');};
 const requireAdmin=owner=>{requireUser(owner);if(db.prepare('SELECT role FROM participant_access WHERE participant_id=?').get(owner)?.role!=='admin')fail(403,'Administrator access is required.');};
 function transaction(work){db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}} // Save content and retry receipts atomically; image decoding happens before the write lock.
 function postAccess(owner,id) {
  requireUser(owner);const post=db.prepare('SELECT p.*,u.label FROM social_posts p JOIN participants u ON u.id=p.owner WHERE p.id=? AND p.deleted IS NULL').get(key(id));
  if(!post||!active(post.owner)||(post.owner!==owner&&post.audience!=='public'&&!friends.accepted(owner,post.owner)))fail(404,'Post not found.');return post;
 } // Public means signed-in members; friends-only posts and all picture reads recheck current access.
 async function picture(value,avatar=false) {
  if(!value||typeof value!=='object')fail(400,'Choose a JPEG, PNG or WebP picture.');
  const alt=text(value.alt??'',200,true),encoded=value.data;
  if(typeof encoded!=='string'||encoded.length>3*1024*1024||! /^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||encoded.length%4!==0)fail(400,'Each picture must be at most 2 MB.');
  const bytes=Buffer.from(encoded,'base64');if(bytes.length<12||bytes.length>2*1024*1024)fail(400,'Each picture must be at most 2 MB.');
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!jpeg&&!png&&!webp)fail(400,'Choose a JPEG, PNG or WebP picture.');
  try {
   const input=sharp(bytes,{limitInputPixels:24*1000*1000,failOn:'warning'}),metadata=await input.metadata();
   if(!['jpeg','png','webp'].includes(metadata.format)||(metadata.pages??1)>1)fail(400,'Choose a still JPEG, PNG or WebP picture.');
   const result=await input.rotate().resize(avatar?{width:512,height:512,fit:'cover'}:{width:1600,height:1600,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:82}).toBuffer({resolveWithObject:true});
   if(result.data.length>2*1024*1024)fail(400,'This picture is too large. Choose a smaller picture.');
   return {id:randomUUID(),alt,width:result.info.width,height:result.info.height,data:result.data};
  }catch(error){if(error.status)throw error;fail(400,'This picture could not be read. Choose a still JPEG, PNG or WebP picture.');}
 } // Decode and re-encode every image: no original metadata, filenames, SVG, animation or remote URLs are stored.
 function avatarInfo(owner){const row=db.prepare('SELECT version FROM social_profiles WHERE owner=? AND data IS NOT NULL').get(owner);return row?{avatarVersion:row.version}:{};}
 function profile(owner){requireUser(owner);const row=db.prepare('SELECT version,data IS NOT NULL AS has_picture FROM social_profiles WHERE owner=?').get(owner);return {version:row?.version??null,avatarVersion:row?.has_picture?row.version:null};}
 function avatar(owner,participantId,version,moderator=false){if(moderator)requireAdmin(owner);else requireUser(owner);key(participantId);if(!moderator&&!active(participantId))fail(404,'Profile picture not found.');const row=db.prepare('SELECT data,version FROM social_profiles WHERE owner=? AND data IS NOT NULL').get(participantId);if(!row||(version&&row.version!==version))fail(404,'Profile picture not found.');return row.data;}
 async function saveProfile(owner,input) {
  requireContributor(owner);const requestId=key(input?.requestId),version=input.version??null;if(version!==null)key(version);
  if(input.picture!==null&&(!input.picture||typeof input.picture!=='object'))fail(400,'Choose a profile picture or remove the current one.');
  const fingerprint=hash({version,picture:input.picture});
  function check(){const current=db.prepare('SELECT version,request_hash FROM social_profiles WHERE owner=?').get(owner);if(current?.version===requestId){if(current.request_hash!==fingerprint)fail(409,'This request belongs to a different profile picture.');return true;}if((current?.version??null)!==version)fail(409,'Your profile picture changed. Refresh before saving again.');return false;}
  if(check())return {...profile(owner),repeated:true};
  const image=input.picture===null?null:await picture(input.picture,true);
  return transaction(()=>{requireContributor(owner);if(check())return {...profile(owner),repeated:true};db.prepare('INSERT INTO social_profiles(owner,version,request_hash,data,updated) VALUES (?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET version=excluded.version,request_hash=excluded.request_hash,data=excluded.data,updated=excluded.updated').run(owner,requestId,fingerprint,image?.data??null,now());return {...profile(owner),repeated:false};});
 } // Compare the loaded version after decoding; retries, other devices and moderation cannot overwrite a newer picture.
 function existingPost(owner,requestId,fingerprint){const row=db.prepare('SELECT id,request_hash,deleted FROM social_posts WHERE owner=? AND request_id=?').get(owner,requestId);if(row&&row.request_hash!==fingerprint)fail(409,'This request already belongs to a different post.');return row?{id:row.id,deleted:Boolean(row.deleted),repeated:true}:null;}
 async function publish(owner,input) {
  requireContributor(owner);if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'Write a status update.');
  const requestId=key(input.requestId),body=text(input.body??'',2000,true),audience=input.audience??'friends',images=input.pictures??[];
  if(!['friends','public'].includes(audience)||!Array.isArray(images)||images.length>4||(!body&&!images.length))fail(400,'Choose an audience and add text or up to four pictures.');
  const fingerprint=hash({body,audience,images}),old=existingPost(owner,requestId,fingerprint);if(old)return old;
  const pictures=[];for(const image of images)pictures.push(await picture(image)); // Decode sequentially so a multi-picture upload has bounded memory use.
  return transaction(()=>{
   requireContributor(owner);const raced=existingPost(owner,requestId,fingerprint);if(raced)return raced;
   const instant=now();if(db.prepare('SELECT COUNT(*) AS n FROM social_posts WHERE owner=? AND created>?').get(owner,instant-60000).n>=10)fail(429,'Please wait a minute before posting again.');
   const used=db.prepare('SELECT COALESCE(SUM(length(i.data)),0) AS n FROM social_pictures i JOIN social_posts p ON p.id=i.post_id WHERE p.owner=?').get(owner).n;
   if(used+pictures.reduce((sum,p)=>sum+p.data.length,0)>100*1024*1024)fail(409,'Your pictures have reached 100 MB. Delete an old picture post to make room.');
   const id=randomUUID();db.prepare('INSERT INTO social_posts(id,owner,request_id,request_hash,body,audience,created) VALUES (?,?,?,?,?,?,?)').run(id,owner,requestId,fingerprint,body,audience,instant);
   pictures.forEach((p,index)=>db.prepare('INSERT INTO social_pictures VALUES (?,?,?,?,?,?,?)').run(p.id,id,index,p.alt,p.width,p.height,p.data));
   for(const friend of friends.list(owner).filter(f=>f.state==='accepted'))activity?.record(friend.participantId,{source:'post:'+id,kind:'friend-post',actor:owner,postId:id,created:instant},true);
   return {id,repeated:false};
  });
 }
 function feed(owner,{audience='friends',before}={}) {
  requireUser(owner);if(!['friends','public'].includes(audience))fail(400,'Choose the Friends or Public feed.');
  const rows=db.prepare(`SELECT p.seq,p.id,p.owner,p.body,p.audience,p.created,u.label FROM social_posts p JOIN participants u ON u.id=p.owner WHERE p.deleted IS NULL AND p.seq<?
   AND NOT EXISTS(SELECT 1 FROM participant_access x WHERE x.participant_id=p.owner AND x.disabled=1)
   AND (${audience==='public'?"p.audience='public'":"(p.owner=? OR EXISTS(SELECT 1 FROM friendships f WHERE f.state='accepted' AND ((f.a=? AND f.b=p.owner) OR (f.b=? AND f.a=p.owner))))"})
   ORDER BY p.seq DESC LIMIT 21`).all(cursor(before),...(audience==='friends'?[owner,owner,owner]:[]));
  return {items:rows.slice(0,20).map(post=>serializePost(owner,post)),nextBefore:rows.length>20?rows[19].seq:null};
 } // Use a stable sequence cursor so new posts do not duplicate or skip older pages.
 function memberProfile(owner,participantId=owner,{before}={}) {
  requireUser(owner);key(participantId);if(!active(participantId))fail(404,'Profile not found.');
  const member=db.prepare('SELECT id,label FROM participants WHERE id=?').get(participantId),isSelf=owner===participantId,isFriend=friends.accepted(owner,participantId);
  const rows=db.prepare("SELECT p.seq,p.id,p.owner,p.body,p.audience,p.created,u.label FROM social_posts p JOIN participants u ON u.id=p.owner WHERE p.owner=? AND p.deleted IS NULL AND p.seq<? AND (?=1 OR p.audience='public') ORDER BY p.seq DESC LIMIT 21").all(participantId,cursor(before),Number(isSelf||isFriend));
  return {member:{...member,...avatarInfo(participantId),isSelf,isFriend},items:rows.slice(0,20).map(post=>serializePost(owner,post)),nextBefore:rows.length>20?rows[19].seq:null};
 } // Profiles reveal only identity and posts the current viewer can read; they never expose tracking records or account credentials.
 function photo(owner,id){requireUser(owner);const row=db.prepare('SELECT * FROM social_pictures WHERE id=?').get(key(id));if(!row)fail(404,'Picture not found.');postAccess(owner,row.post_id);return row.data;}
 function removePost(id){db.prepare('DELETE FROM social_pictures WHERE post_id=?').run(id);db.prepare("UPDATE social_posts SET body='',deleted=COALESCE(deleted,?) WHERE id=?").run(now(),id);db.prepare("UPDATE social_comments SET body='',deleted=COALESCE(deleted,?) WHERE post_id=?").run(now(),id);db.prepare('DELETE FROM social_likes WHERE post_id=?').run(id);withdrawPost(id);}
 function deletePost(owner,id){requireUser(owner);return transaction(()=>{const row=db.prepare('SELECT id FROM social_posts WHERE id=? AND owner=?').get(key(id),owner);if(!row)fail(404,'Post not found.');removePost(id);return {removed:true};});} // Retain retry receipts after deletion so a lost response cannot resurrect content.
 function thread(owner,peer){requireUser(owner);key(peer);if(!friends.accepted(owner,peer))fail(403,'Messaging is available between accepted friends.');return db.prepare("SELECT id FROM friendships WHERE a=? AND b=? AND state='accepted'").get(...[owner,peer].sort()).id;}
 function conversations(owner) {
  requireUser(owner);return friends.list(owner).filter(f=>f.state==='accepted').map(f=>{
   const latest=db.prepare('SELECT seq,sender,body,created,deleted FROM friend_messages WHERE friendship_id=? ORDER BY seq DESC LIMIT 1').get(f.id);
   const unread=db.prepare('SELECT COUNT(*) AS n FROM friend_messages WHERE friendship_id=? AND sender<>? AND deleted IS NULL AND seq>COALESCE((SELECT seq FROM friend_message_reads WHERE friendship_id=? AND owner=?),0)').get(f.id,owner,f.id,owner).n;
   return {friend:{id:f.participantId,label:f.label,...avatarInfo(f.participantId)},latest:latest??null,unread};
  }).sort((a,b)=>(b.latest?.seq??0)-(a.latest?.seq??0));
 }
 function messages(owner,peer,{before}={}) {
  const id=thread(owner,peer),rows=db.prepare('SELECT seq,id,sender,body,created,deleted FROM friend_messages WHERE friendship_id=? AND seq<? ORDER BY seq DESC LIMIT 51').all(id,cursor(before));
  return {items:rows.slice(0,50).reverse(),nextBefore:rows.length>50?rows[49].seq:null};
 }
 function sendMessage(owner,input) {
  requireContributor(owner);if(!input||typeof input!=='object')fail(400,'Write a message.');
  const peer=key(input.participantId),requestId=key(input.requestId),body=text(input.body,4000),fingerprint=hash({peer,body});
  return transaction(()=>{
   const id=thread(owner,peer),old=db.prepare('SELECT message_id AS id,request_hash,friendship_id FROM friend_message_receipts WHERE sender=? AND request_id=?').get(owner,requestId);
   if(old){if(old.friendship_id!==id)fail(409,'This conversation changed. Start a new message.');if(old.request_hash!==fingerprint)fail(409,'This request already belongs to a different message.');return {id:old.id,repeated:true};}
   if(db.prepare('SELECT COUNT(*) AS n FROM friend_messages WHERE sender=? AND created>?').get(owner,now()-60000).n>=60)fail(429,'Please wait a minute before sending more messages.');
   const messageId=randomUUID();db.prepare('INSERT INTO friend_messages(id,friendship_id,sender,request_id,request_hash,body,created) VALUES (?,?,?,?,?,?,?)').run(messageId,id,owner,requestId,fingerprint,body,now());db.prepare('INSERT INTO friend_message_receipts VALUES (?,?,?,?,?)').run(owner,requestId,fingerprint,id,messageId);return {id:messageId,repeated:false};
  });
 } // The current accepted relationship owns the conversation; retries cannot duplicate a message or choose another sender.
 function readMessages(owner,input){const id=thread(owner,key(input?.participantId)),seq=Number(input.seq);if(!Number.isSafeInteger(seq)||!db.prepare('SELECT 1 FROM friend_messages WHERE friendship_id=? AND seq=?').get(id,seq))fail(400,'Choose a message in this conversation.');db.prepare('INSERT INTO friend_message_reads VALUES (?,?,?) ON CONFLICT(friendship_id,owner) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(id,owner,seq);return {read:true};}
 function deleteMessage(owner,id){requireUser(owner);const row=db.prepare('SELECT friendship_id FROM friend_messages WHERE id=? AND sender=?').get(key(id),owner);if(!row)fail(404,'Message not found.');db.prepare("UPDATE friend_messages SET body='',deleted=COALESCE(deleted,?) WHERE id=? AND sender=?").run(now(),id,owner);return {removed:true};}
 function serializePost(viewer,{owner,label,...post}) {
  const {request_id,request_hash,deleted,...safe}=post;
  return {...safe,author:{id:owner,label,...avatarInfo(owner)},pictures:db.prepare('SELECT id,alt,width,height FROM social_pictures WHERE post_id=? ORDER BY position').all(post.id),...counts(viewer,post.id)};
 } // Never expose write receipts; ordinary reads and moderation share the same safe post representation.
 function counts(owner,id){return {likes:db.prepare('SELECT COUNT(*) AS n FROM social_likes l WHERE post_id=? AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=l.owner AND a.disabled=1)').get(id).n,liked:Boolean(db.prepare('SELECT 1 FROM social_likes WHERE post_id=? AND owner=?').get(id,owner)),comments:db.prepare('SELECT COUNT(*) AS n FROM social_comments c WHERE post_id=? AND deleted IS NULL AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=c.owner AND a.disabled=1)').get(id).n};}
 function post(owner,id){return serializePost(owner,postAccess(owner,id));}
 function withdrawPost(id,commentId){if(!activity)return;for(const row of db.prepare('SELECT id FROM activity_notifications WHERE post_id=?'+(commentId?' AND comment_id=?':'')).all(id,...(commentId?[commentId]:[])))activity.withdraw(row.id);}
 function like(owner,input) {
  requireContributor(owner);if(typeof input?.liked!=='boolean')fail(400,'Choose like or unlike.');
  return transaction(()=>{const p=postAccess(owner,input.postId);
   if(input.liked){if(db.prepare('INSERT OR IGNORE INTO social_likes VALUES (?,?,?)').run(p.id,owner,now()).changes)activity?.record(p.owner,{source:'like:'+p.id+':'+owner,kind:'like',actor:owner,postId:p.id,created:now()},true);}
   else {db.prepare('DELETE FROM social_likes WHERE post_id=? AND owner=?').run(p.id,owner);if(activity){const row=db.prepare('SELECT id FROM activity_notifications WHERE owner=? AND source=?').get(p.owner,'like:'+p.id+':'+owner);if(row)activity.withdraw(row.id);}}
   return counts(owner,p.id);
  });
 } // A like is unique per member/post; explicit desired state makes retries safe and toggling cannot spam notifications.
 function commentList(owner,postId,{before}={}) {postAccess(owner,postId);return commentRows(postId,before);}
 function commentRows(postId,before) {
  const rows=db.prepare('SELECT c.seq,c.id,c.post_id AS postId,c.owner,c.body,c.created,p.label FROM social_comments c JOIN participants p ON p.id=c.owner WHERE c.post_id=? AND c.deleted IS NULL AND c.seq<? AND NOT EXISTS(SELECT 1 FROM participant_access a WHERE a.participant_id=c.owner AND a.disabled=1) ORDER BY c.seq DESC LIMIT 31').all(postId,cursor(before));
  return {items:rows.slice(0,30).reverse().map(({owner,label,...row})=>({...row,author:{id:owner,label,...avatarInfo(owner)}})),nextBefore:rows.length>30?rows[29].seq:null};
 }
 function comment(owner,input) {
  requireContributor(owner);const requestId=key(input?.requestId),postId=key(input.postId),body=text(input.body,2000),fingerprint=hash({postId,body});
  return transaction(()=>{const p=postAccess(owner,postId),old=db.prepare('SELECT id,request_hash FROM social_comments WHERE owner=? AND request_id=?').get(owner,requestId);
   if(old){if(old.request_hash!==fingerprint)fail(409,'This request belongs to another comment.');return {id:old.id,repeated:true};}
   if(db.prepare('SELECT COUNT(*) AS n FROM social_comments WHERE owner=? AND created>?').get(owner,now()-60000).n>=20)fail(429,'Please wait a minute before commenting again.');
   const id=randomUUID();db.prepare('INSERT INTO social_comments(id,post_id,owner,request_id,request_hash,body,created) VALUES (?,?,?,?,?,?,?)').run(id,postId,owner,requestId,fingerprint,body,now());
   activity?.record(p.owner,{source:'comment:'+id,kind:'comment',actor:owner,postId,commentId:id,created:now()},true);return {id,repeated:false};
  });
 } // Comment access follows the parent audience, and its notification commits with the comment itself.
 function deleteComment(owner,id) {requireUser(owner);return transaction(()=>{const c=db.prepare('SELECT * FROM social_comments WHERE id=?').get(key(id));if(!c)fail(404,'Comment not found.');const p=postAccess(owner,c.post_id);if(c.owner!==owner&&p.owner!==owner)fail(403,'Only the comment author or post owner can remove this comment.');db.prepare("UPDATE social_comments SET body='',deleted=COALESCE(deleted,?) WHERE id=?").run(now(),id);withdrawPost(c.post_id,c.id);return {removed:true};});}
 function activityVisible(row) {
  if(!['like','comment','friend-post'].includes(row.kind))return true;
  try{postAccess(row.owner,row.post_id);postAccess(row.actor,row.post_id);}catch{return false;}
  if(row.kind==='friend-post')return friends.accepted(row.owner,row.actor);
  if(row.kind==='like')return Boolean(db.prepare('SELECT 1 FROM social_likes WHERE post_id=? AND owner=?').get(row.post_id,row.actor));
  return Boolean(db.prepare('SELECT 1 FROM social_comments WHERE id=? AND deleted IS NULL').get(row.comment_id));
 } // Stored notifications and queued pushes lose access when their underlying content or friendship is removed.
 function target(kind,id) {
  const table={post:'social_posts',comment:'social_comments',message:'friend_messages'}[kind];if(!table)fail(400,'Choose a post, comment or message.');
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key(id));
 }
 function report(owner,input) {
  requireUser(owner);const kind=input?.kind,id=key(input?.id),reason=text(input?.reason,1000),item=target(kind,id);if(!item||item.deleted)fail(404,'Content is no longer available.');
  if(kind==='post')postAccess(owner,id);else if(kind==='comment')postAccess(owner,item.post_id);else {const f=db.prepare('SELECT * FROM friendships WHERE id=?').get(item.friendship_id);if(!f||![f.a,f.b].includes(owner))fail(404,'Message not found.');thread(owner,f.a===owner?f.b:f.a);}
  return transaction(()=>{const existing=db.prepare('SELECT id FROM social_reports WHERE reporter=? AND kind=? AND target=?').get(owner,kind,id);if(existing)return {id:existing.id,repeated:true};
   if(db.prepare('SELECT COUNT(*) AS n FROM social_reports WHERE reporter=? AND created>?').get(owner,now()-3600000).n>=20)fail(429,'Please wait before sending another report.');
   const reportId=randomUUID();db.prepare('INSERT INTO social_reports(id,reporter,kind,target,reason,created) VALUES (?,?,?,?,?,?)').run(reportId,owner,kind,id,reason,now());return {id:reportId,repeated:false};});
 } // A report grants moderators access to that reported message only, never its whole private conversation.
 function moderation(owner,{view='reports',before,postId}={}) {
  requireAdmin(owner);
  if(view==='profiles'){const rows=db.prepare('SELECT s.seq,s.owner AS id,s.version AS avatarVersion,p.label FROM social_profiles s JOIN participants p ON p.id=s.owner WHERE s.data IS NOT NULL AND s.seq<? ORDER BY s.seq DESC LIMIT 31').all(cursor(before));return {items:rows.slice(0,30),nextBefore:rows.length>30?rows[29].seq:null};}
  if(postId){const p=target('post',postId);if(!p||p.deleted)fail(404,'Post not found.');return {post:serializePost(owner,{...p,label:db.prepare('SELECT label FROM participants WHERE id=?').get(p.owner).label}),...commentRows(postId,before)};}
  if(view==='restrictions')return {items:db.prepare('SELECT r.*,p.label FROM social_restrictions r JOIN participants p ON p.id=r.owner ORDER BY r.created DESC').all(),nextBefore:null};
  if(view==='posts'){const rows=db.prepare('SELECT p.*,u.label FROM social_posts p JOIN participants u ON u.id=p.owner WHERE p.deleted IS NULL AND p.seq<? ORDER BY p.seq DESC LIMIT 31').all(cursor(before));return {items:rows.slice(0,30).map(p=>serializePost(owner,p)),nextBefore:rows.length>30?rows[29].seq:null};}
  if(view!=='reports')fail(400,'Choose a moderation view.');
  const rows=db.prepare("SELECT r.*,p.label AS reporterLabel FROM social_reports r JOIN participants p ON p.id=r.reporter WHERE r.state='open' AND r.seq<? ORDER BY r.seq DESC LIMIT 31").all(cursor(before));
  return {items:rows.slice(0,30).map(r=>{const item=target(r.kind,r.target),author=item?.owner??item?.sender;return {...r,content:item&&!item.deleted?{body:item.body,author,authorLabel:db.prepare('SELECT label FROM participants WHERE id=?').get(author)?.label,postId:r.kind==='post'?item.id:item.post_id??null}:null};}),nextBefore:rows.length>30?rows[29].seq:null};
 }
 function moderationPhoto(owner,id){requireAdmin(owner);const row=db.prepare('SELECT i.data FROM social_pictures i JOIN social_posts p ON p.id=i.post_id WHERE i.id=? AND p.deleted IS NULL').get(key(id));if(!row)fail(404,'Picture not found.');return row.data;}
 function moderate(owner,input) {
  requireAdmin(owner);const reason=text(input?.reason,1000),action=input?.action;
  return transaction(()=>{
   requireAdmin(owner);let targetId;
   if(action==='remove-profile') {
    targetId=key(input.participantId);const current=db.prepare('SELECT version FROM social_profiles WHERE owner=? AND data IS NOT NULL').get(targetId);if(!current||current.version!==input.version)fail(409,'This profile picture changed. Refresh moderation before removing it.');db.prepare("UPDATE social_profiles SET data=NULL,version=?,request_hash='moderated',updated=? WHERE owner=?").run(randomUUID(),now(),targetId);
   }else if(action==='restrict'||action==='restore') {
    targetId=key(input.participantId);if(!active(targetId))fail(404,'Member not found.');if(targetId===owner)fail(400,'Use another administrator to review your own account.');
    if(action==='restrict')db.prepare('INSERT INTO social_restrictions VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET reason=excluded.reason,actor=excluded.actor,created=excluded.created').run(targetId,reason,owner,now());else db.prepare('DELETE FROM social_restrictions WHERE owner=?').run(targetId);
   }else if(action==='dismiss') {targetId=key(input.reportId);if(!db.prepare('SELECT 1 FROM social_reports WHERE id=?').get(targetId))fail(404,'Report not found.');db.prepare("UPDATE social_reports SET state='dismissed',resolution=? WHERE id=? AND state='open'").run(reason,targetId);}
   else if(action==='remove') {
    const kind=input.kind;targetId=key(input.id);const item=target(kind,targetId);if(!item)fail(404,'Content not found.');
    if(kind==='message'&&!db.prepare("SELECT 1 FROM social_reports WHERE kind='message' AND target=?").get(targetId))fail(403,'A participant must report this private message before moderation.');
    if(kind==='post'){removePost(targetId);db.prepare("UPDATE social_reports SET state='removed',resolution=? WHERE kind='comment' AND target IN (SELECT id FROM social_comments WHERE post_id=?) AND state='open'").run(reason,targetId);}else if(kind==='comment'){db.prepare("UPDATE social_comments SET body='',deleted=COALESCE(deleted,?) WHERE id=?").run(now(),targetId);withdrawPost(item.post_id,targetId);}else db.prepare("UPDATE friend_messages SET body='',deleted=COALESCE(deleted,?) WHERE id=?").run(now(),targetId);
    db.prepare("UPDATE social_reports SET state='removed',resolution=? WHERE kind=? AND target=? AND state='open'").run(reason,kind,targetId);
   }else fail(400,'Choose a moderation action.');
   db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),owner,'social-'+action,targetId,JSON.stringify({reason,kind:input.kind??null}),new Date(now()).toISOString());return {saved:true};
  });
 } // Require a reason and live admin role for every action; audit records contain decisions, not private content copies.
 return {publish,feed,post,photo,deletePost,conversations,messages,sendMessage,readMessages,deleteMessage,like,comment,commentList,deleteComment,report,moderation,moderationPhoto,moderate,activityVisible,profile,saveProfile,avatar,avatarInfo,memberProfile};
}
