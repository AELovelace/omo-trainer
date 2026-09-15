import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './database.mjs';
import { MAX_ENTRIES } from '../lib/model.js';
import { parseAdminImport } from './admin-transfer.mjs';

export function createAdminStore(db, records, growthChart,{onRecordWrite=()=>{}}={}) { // App roles are bound to immutable participant identities, separate from public profile labels.
  db.exec(`
    CREATE TABLE IF NOT EXISTS participant_access (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id), role TEXT NOT NULL DEFAULT 'participant',
      disabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_audit (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES participants(id), action TEXT NOT NULL,
      target_id TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const access = id => db.prepare("SELECT role, disabled, version FROM participant_access WHERE participant_id=?").get(id) ?? {role:'participant',disabled:0,version:0};
  function requireAdmin(id) { // Recheck live permissions for every privileged read or write, including existing sessions.
    const current=access(id);
    if(current.role!=='admin' || current.disabled) throw new ApiError(403,'Administrator access is required.');
  }
  function audit(actor,action,target,details={}) { // Keep an attributable activity trail without copying private record content into logs.
    db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),actor,action,target,JSON.stringify(details),new Date().toISOString());
  }
  function bootstrap(id) { // Only a server-local operator may bind the first admin after looking up the trusted identity database.
    db.exec('BEGIN IMMEDIATE');
    try {
      if(!db.prepare('SELECT id FROM participants WHERE id=?').get(id)) throw new ApiError(404,'Participant not found.');
      const bound=db.prepare("SELECT value FROM admin_settings WHERE key='initial_admin'").get();
      if(bound) {
        if(bound.value!==id || access(id).role!=='admin') throw new ApiError(409,'The first administrator is already configured. Use user management.');
      } else {
        if(db.prepare("SELECT 1 FROM participant_access WHERE role='admin'").get()) throw new ApiError(409,'An administrator already exists.');
        db.prepare("INSERT INTO participant_access VALUES (?,'admin',0,1) ON CONFLICT(participant_id) DO UPDATE SET role='admin',disabled=0,version=version+1").run(id);
        db.prepare("INSERT INTO admin_settings VALUES ('initial_admin',?)").run(id);
        audit(id,'bootstrap-admin',id);
      }
      db.exec('COMMIT'); return access(id);
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  function reminder(key='reminder') { // Site notices have independent versions and contain no participant data or editor identity.
    if(!['reminder','margin-note'].includes(key))throw new ApiError(404,'Notice not found.');
    const row=db.prepare('SELECT value FROM admin_settings WHERE key=?').get(key);
    return row?JSON.parse(row.value):{text:key==='margin-note'?'\u201cThey kept the records.\nSomeone kept a copy.\u201d':'',enabled:key==='margin-note',version:0,updatedAt:null};
  }
  function saveReminder(actor,input,key='reminder') { // Version checks protect another administrator's edit; an identical retry does not republish or duplicate its audit entry.
    requireAdmin(actor);
    reminder(key); // Validate the internal notice key before using it in a write.
    const limit=key==='margin-note'?2000:500;
    if(!input||typeof input.text!=='string'||input.text.length>limit||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.version)||input.version<0)throw new ApiError(400,'Use text of at most '+limit+' characters and a valid version.');
    const text=key==='margin-note'?input.text.trim().replace(/\r\n?/g,'\n'):input.text.trim().replace(/\s+/g,' ');
    if(input.enabled&&!text)throw new ApiError(400,'Enter some text before showing this notice.');
    db.exec('BEGIN IMMEDIATE');
    try {
      requireAdmin(actor);const current=reminder(key);
      if(current.text===text&&current.enabled===input.enabled) {db.exec('COMMIT');return current;}
      if(current.version!==input.version)throw new ApiError(409,'Another administrator changed this notice. Load the latest text before saving again.');
      const value={text,enabled:input.enabled,version:current.version+1,updatedAt:new Date().toISOString()};
      db.prepare('INSERT INTO admin_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
      audit(actor,'update-'+key,null,{version:value.version,enabled:value.enabled,length:text.length});
      db.exec('COMMIT');return value;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function users(actor) { // Counts distinguish live entries from tombstones; identity-service secrets are never queried.
    requireAdmin(actor);
    return db.prepare(`SELECT p.id,p.label,p.issuer,p.subject,p.created_at AS createdAt,
      COALESCE(a.role,'participant') AS role,COALESCE(a.disabled,0) AS disabled,COALESCE(a.version,0) AS version,
      (SELECT COUNT(*) FROM entries e WHERE e.participant_id=p.id AND e.deleted_at IS NULL) AS recordCount,
      (SELECT COUNT(*) FROM growth_charts c WHERE c.participant_id=p.id) AS hasChart
      FROM participants p LEFT JOIN participant_access a ON a.participant_id=p.id ORDER BY p.label,p.id`).all();
  }
  function updateUser(actor,input) { // Versioned access changes revoke affected sessions and cannot remove the last enabled administrator.
    requireAdmin(actor);
    if(!input || !['update','revoke'].includes(input.action) || typeof input.id!=='string') throw new ApiError(400,'Invalid user action.');
    db.exec('BEGIN IMMEDIATE');
    try {
      requireAdmin(actor);
      if(!db.prepare('SELECT id FROM participants WHERE id=?').get(input.id)) throw new ApiError(404,'Participant not found.');
      const current=access(input.id);
      if(input.version!==current.version) throw new ApiError(409,'This user changed. Refresh before updating.');
      if(input.action==='update') {
        if(!['admin','participant'].includes(input.role) || typeof input.disabled!=='boolean') throw new ApiError(400,'Invalid role or access status.');
        if(current.role==='admin' && !current.disabled && (input.role!=='admin' || input.disabled) &&
          db.prepare("SELECT COUNT(*) AS n FROM participant_access WHERE role='admin' AND disabled=0").get().n<=1) throw new ApiError(409,'Keep at least one enabled administrator.');
        db.prepare('INSERT INTO participant_access VALUES (?,?,?,1) ON CONFLICT(participant_id) DO UPDATE SET role=excluded.role,disabled=excluded.disabled,version=version+1')
          .run(input.id,input.role,Number(input.disabled));
      }
      db.prepare('DELETE FROM app_sessions WHERE participant_id=?').run(input.id);
      audit(actor,input.action==='revoke'?'revoke-sessions':'update-access',input.id,input.action==='revoke'?{}:{role:input.role,disabled:input.disabled});
      db.exec('COMMIT'); return {ok:true};
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  function dataset(actor,participantId='') { // Return complete current records and chart definitions for the requested cohort, with no passwords or role import fields.
    requireAdmin(actor);
    const selected=users(actor).filter(user=>!participantId || user.id===participantId);
    if(participantId && !selected.length) throw new ApiError(404,'Participant not found.');
    return {format:'little-log-admin',schemaVersion:1,exportedAt:new Date().toISOString(),
      users:selected.map(user=>({id:user.id,label:user.label,createdAt:user.createdAt,records:records(user.id).filter(record=>record.entry),growthChart:growthChart(user.id)}))};
  }
  function charts(actor) { // Poll only chart snapshots, without repeatedly transferring every observation record.
    requireAdmin(actor);
    return {users:users(actor).map(user=>({id:user.id,growthChart:growthChart(user.id)}))};
  }
  function plan(input) { // Validate the whole batch and fingerprint reviewed database versions before an all-or-nothing import.
    let incoming;
    try { incoming=parseAdminImport(input); } catch(error) { throw new ApiError(400,error.message); }
    if(!['merge','replace'].includes(input.mode)) throw new ApiError(400,'Choose merge or replace conflicts.');
    const summary={users:incoming.length,added:0,updated:0,unchanged:0,chartsAdded:0,chartsUpdated:0,conflicts:0};
    const writes=[], versions=[];
    for(const user of incoming) {
      if(!db.prepare('SELECT id FROM participants WHERE id=?').get(user.id)) throw new ApiError(400,'Unknown participant '+user.id+'. Users must sign in before their records can be imported.');
      const current=new Map(records(user.id).map(record=>[record.id,record]));
      let additions=0;
      for(const value of user.records) {
        const previous=current.get(value.id);
        versions.push([user.id,value.id,previous?.version??0]);
        if(previous?.entry && JSON.stringify(previous.entry)===JSON.stringify(value)) { summary.unchanged++; continue; }
        if(previous && input.mode==='merge') { summary.conflicts++; continue; }
        if(previous) summary.updated++; else { summary.added++; additions++; }
        writes.push({type:'entry',participantId:user.id,value,version:(previous?.version??0)+1});
      }
      if(current.size+additions>MAX_ENTRIES) throw new ApiError(400,'An imported participant would exceed the 50,000-record limit.');
      if(user.chart) {
        const previous=growthChart(user.id);
        versions.push([user.id,'chart',previous.version]);
        if(JSON.stringify(previous.chart)===JSON.stringify(user.chart)) summary.unchanged++;
        else if(previous.chart && input.mode==='merge') summary.conflicts++;
        else {
          if(previous.chart) summary.chartsUpdated++; else summary.chartsAdded++;
          writes.push({type:'chart',participantId:user.id,value:user.chart,version:previous.version+1});
        }
      }
    }
    const token=createHash('sha256').update(JSON.stringify({incoming,mode:input.mode,versions})).digest('hex');
    return {summary,writes,token};
  }
  function previewImport(actor,input) {
    requireAdmin(actor);
    const {summary,token}=plan(input);
    return {summary,token};
  }
  function importData(actor,input) { // Recompute the reviewed plan under the write lock; stale or invalid batches never partially apply.
    requireAdmin(actor); db.exec('BEGIN IMMEDIATE');
    try {
      requireAdmin(actor);
      const result=plan(input);
      if(typeof input.token!=='string' || result.token!==input.token) throw new ApiError(409,'Data changed after preview. Preview the file again.');
      if(result.summary.conflicts) throw new ApiError(409,'This file conflicts with saved data. Preview again with Replace conflicts if you intend to replace them.');
      const now=new Date().toISOString();
      for(const write of result.writes) {
        const e=write.value;
        if(write.type==='chart') db.prepare('INSERT INTO growth_charts VALUES (?,?,?,?) ON CONFLICT(participant_id) DO UPDATE SET payload_json=excluded.payload_json,version=excluded.version,updated_at=excluded.updated_at')
          .run(write.participantId,JSON.stringify(e),write.version,now);
        else db.prepare(`INSERT INTO entries (participant_id,id,occurred_at,liquids_ml,position,diaper_number,wettings_count,probability,result,source,edited,version,created_at,updated_at,deleted_at,payload_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(participant_id,id) DO UPDATE SET occurred_at=excluded.occurred_at,liquids_ml=excluded.liquids_ml,
          position=excluded.position,diaper_number=excluded.diaper_number,wettings_count=excluded.wettings_count,probability=excluded.probability,result=excluded.result,
          source=excluded.source,edited=excluded.edited,version=excluded.version,updated_at=excluded.updated_at,deleted_at=NULL,payload_json=excluded.payload_json`)
          .run(write.participantId,e.id,e.occurredAt,e.liquidsMl??null,e.position??null,e.diaperNumber??null,e.wettingsCount??null,e.probability??null,
            e.result??null,e.source??null,e.edited===undefined?null:Number(e.edited),write.version,now,now,JSON.stringify(e));
        if(write.type!=='chart')onRecordWrite(write.participantId,e); // Keep already-shared summaries accurate without making new timeline posts from imports.
      }
      audit(actor,'import',input.participantId||null,result.summary);
      db.exec('COMMIT'); return result.summary;
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  }
  return {access,requireAdmin,bootstrap,reminder,saveReminder,users,updateUser,dataset,charts,previewImport,importData,
    auditList(actor) { requireAdmin(actor); return db.prepare('SELECT * FROM admin_audit ORDER BY created_at DESC,rowid DESC LIMIT 100').all(); }};
}
