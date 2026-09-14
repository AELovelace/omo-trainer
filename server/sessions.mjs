import {createHash,randomBytes} from 'node:crypto';
import {ApiError} from './database.mjs';

export const SESSION_IDLE_SECONDS=30*86400;
export const SESSION_MAX_SECONDS=180*86400;
const RENEW_INTERVAL_MS=86400000;
const digest=value=>createHash('sha256').update(value).digest('hex'); // Only a digest of the browser's opaque session credential reaches SQLite.

export function createSessions(db,admin,{now=Date.now}={}) { // Keep browser persistence independent of short-lived OIDC access tokens.
  db.exec('BEGIN IMMEDIATE');
  try{
    if(!db.prepare('PRAGMA table_info(app_sessions)').all().some(column=>column.name==='absolute_expires')){
      db.exec('ALTER TABLE app_sessions ADD COLUMN absolute_expires INTEGER NOT NULL DEFAULT 0');
      db.prepare('UPDATE app_sessions SET absolute_expires=expires-3600000+?').run(SESSION_MAX_SECONDS*1000); // Infer the original sign-in time of legacy one-hour sessions without reviving expired ones.
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  function create(participantId){
    if(admin.access(participantId).disabled)throw new ApiError(403,'Little Log access is disabled. Contact an administrator.');
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),time=now();
    db.prepare('DELETE FROM app_sessions WHERE expires<=? OR absolute_expires<=?').run(time,time);
    db.prepare('INSERT INTO app_sessions(token_hash,participant_id,csrf,expires,absolute_expires) VALUES (?,?,?,?,?)')
      .run(digest(token),participantId,csrf,time+SESSION_IDLE_SECONDS*1000,time+SESSION_MAX_SECONDS*1000);
    return token;
  }
  function read(token,{renew=false}={}) { // Expired/revoked sessions cannot renew; labels and roles always come from current account state.
    if(typeof token!=='string'||!/^[-_A-Za-z0-9]{43}$/.test(token))return null;
    const key=digest(token),time=now();
    const row=db.prepare(`SELECT p.id,p.label,s.csrf,s.expires,s.absolute_expires FROM app_sessions s JOIN participants p ON p.id=s.participant_id
      WHERE s.token_hash=? AND s.expires>? AND s.absolute_expires>?`).get(key,time,time);
    if(!row)return null;const access=admin.access(row.id);if(access.disabled)return null;
    const desired=Math.min(time+SESSION_IDLE_SECONDS*1000,row.absolute_expires);
    if(renew&&desired>row.expires&&(desired-row.expires>=RENEW_INTERVAL_MS||desired===row.absolute_expires)){ // Refresh daily, including the final partial day before the absolute limit.
      const updated=db.prepare(`UPDATE app_sessions SET expires=max(expires,?) WHERE token_hash=? AND expires>? AND absolute_expires>?
        RETURNING expires`).get(desired,key,time,time);
      if(!updated)return null;row.expires=updated.expires; // A concurrently revoked session is never reinserted.
    }
    return {participant:{id:row.id,label:row.label},csrf:row.csrf,role:access.role,expiresAt:row.expires};
  }
  function remove(token){if(token)db.prepare('DELETE FROM app_sessions WHERE token_hash=?').run(digest(token));} // Sign-out invalidates the server record, even if another tab retains its old cookie.
  return {create,read,remove,now};
}
