import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {ApiError} from './database.mjs';

const digest=secret=>createHash('sha256').update(secret).digest('hex'); // Store only the digest; the full report token is returned once when created.
export function createReportAccess(db,admin,{now=Date.now}={}) { // Report integrations have separate read-only credentials, never ordinary wallet or browser tokens.
  db.exec(`CREATE TABLE IF NOT EXISTS ai_report_tokens(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES participants(id),name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,revoked INTEGER);
    CREATE TABLE IF NOT EXISTS ai_report_feed(cursor INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL UNIQUE REFERENCES ai_analysis_jobs(id));
    INSERT OR IGNORE INTO ai_report_feed(job_id) SELECT id FROM ai_analysis_jobs j WHERE status='completed' AND document IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ai_report_feed f WHERE f.job_id=j.id) ORDER BY finished,rowid;`);
  const metadata='f.cursor,j.id,j.day,j.source,j.schedule_day AS scheduled_for,j.created,j.finished,j.model_used,j.finish_reason';
  const nightly="j.status='completed' AND j.source='daily' AND j.schedule_day IS NOT NULL"; // Only the scheduler can create a daily job; manual runs cannot opt into the bot feed.
  function audit(actor,action,id){db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),actor,action,id,'{}',new Date(now()).toISOString());} // Keep credentials and report contents out of activity logs.
  function list(actor){admin.requireAdmin(actor);return db.prepare('SELECT id,name,actor_id,created,revoked FROM ai_report_tokens ORDER BY created DESC,rowid DESC LIMIT 100').all();}
  function create(actor,input){
    admin.requireAdmin(actor);
    if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw new ApiError(400,'Name the report connection using up to 80 characters.');
    db.exec('BEGIN IMMEDIATE');
    try{
      if(db.prepare('SELECT count(*) AS n FROM ai_report_tokens WHERE revoked IS NULL').get().n>=10)throw new ApiError(409,'Revoke an unused report token before creating another.');
      const id=randomUUID(),token='llreport_'+randomBytes(32).toString('base64url'),created=now();
      db.prepare('INSERT INTO ai_report_tokens VALUES (?,?,?,?,?,NULL)').run(id,actor,input.name.trim(),digest(token),created);
      audit(actor,'ai-report-token-created',id);db.exec('COMMIT');return {id,name:input.name.trim(),token,created,scope:'reports:read'};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function revoke(actor,input){
    admin.requireAdmin(actor);if(!input||typeof input.id!=='string')throw new ApiError(400,'Choose a report token.');
    db.exec('BEGIN IMMEDIATE');
    try{
      const row=db.prepare('SELECT revoked FROM ai_report_tokens WHERE id=?').get(input.id);if(!row)throw new ApiError(404,'Report token not found.');
      if(row.revoked===null){db.prepare('UPDATE ai_report_tokens SET revoked=? WHERE id=?').run(now(),input.id);audit(actor,'ai-report-token-revoked',input.id);}
      db.exec('COMMIT');return {revoked:true};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function authorize(secret){ // Demoting or disabling the administrator immediately removes the connection's report access.
    if(typeof secret!=='string'||!/^llreport_[A-Za-z0-9_-]{43}$/.test(secret))throw new ApiError(401,'A report-read bearer token is required.');
    const token=db.prepare('SELECT actor_id FROM ai_report_tokens WHERE token_hash=? AND revoked IS NULL').get(digest(secret));
    if(!token)throw new ApiError(401,'Report token is invalid or revoked.');admin.requireAdmin(token.actor_id);
  }
  function number(value,fallback,min,max){if(value===null||value===undefined)return fallback;if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw new ApiError(400,'Invalid cursor or page limit.');return Number(value);}
  function feed(secret,{after,limit}={}) { // Completion cursors prevent an older queued job from being missed when it finishes after a newer job.
    authorize(secret);const cursor=number(after,0,0,Number.MAX_SAFE_INTEGER),size=number(limit,20,1,100);
    const rows=db.prepare(`SELECT ${metadata} FROM ai_report_feed f JOIN ai_analysis_jobs j ON j.id=f.job_id WHERE f.cursor>? AND ${nightly} ORDER BY f.cursor LIMIT ?`).all(cursor,size+1);
    const hasMore=rows.length>size,reports=rows.slice(0,size),latestCursor=db.prepare(`SELECT COALESCE(max(f.cursor),0) AS n FROM ai_report_feed f JOIN ai_analysis_jobs j ON j.id=f.job_id WHERE ${nightly}`).get().n;
    return {reports,next_cursor:reports.at(-1)?.cursor??cursor,latest_cursor:latestCursor,has_more:hasMore};
  }
  function report(secret,id) { // Export only the finished document and descriptive metadata; prompt drafts, source snapshots and job controls stay in the console.
    authorize(secret);if(typeof id!=='string'||id.length>80)throw new ApiError(400,'Invalid report ID.');
    const row=db.prepare(`SELECT ${metadata},j.document FROM ai_report_feed f JOIN ai_analysis_jobs j ON j.id=f.job_id WHERE j.id=? AND ${nightly}`).get(id);
    if(!row)throw new ApiError(404,'Completed nightly report not found.');return {...row,format:'markdown',incomplete:row.finish_reason==='length'};
  }
  return {list,create,revoke,feed,report};
}

export function reportApi(database,login,request,response,route) { // The external API accepts only bearer-authenticated reads, and never falls through to cookie-based admin routes.
  const send=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',Vary:'Authorization, Origin'});response.end(JSON.stringify(value));};
  try{
    if(request.headers['sec-fetch-site']==='cross-site'||(request.headers.origin&&request.headers.origin!==login.origin))throw new ApiError(403,'This origin is not allowed.');
    if(request.method!=='GET'){response.setHeader('Allow','GET');throw new ApiError(405,'This report API is read-only.');}
    const secret=/^Bearer (llreport_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1],query=new URL(request.url,login.origin).searchParams;
    if(route==='reports')return send(200,database.aiAnalysis.integrations.feed(secret,{after:query.get('after'),limit:query.get('limit')}));
    const match=/^reports\/([A-Za-z0-9_-]{1,80})$/.exec(route);
    if(match)return send(200,database.aiAnalysis.integrations.report(secret,match[1]));
    throw new ApiError(404,'Report endpoint not found.');
  }catch(error){send(error.status??500,{error:error.status?error.message:'Report request failed. Please retry.'});}
}
