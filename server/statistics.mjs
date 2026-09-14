import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {ApiError} from './database.mjs';
import {aggregateAnalysis,analysisDay,shiftDay,AI_ZONE} from './ai-analysis.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex'); // Device credentials are stored only as SHA-256 digests.
const fields=['observations','liquidsMl','wettings','diaperChanges','chartStars','randomRolls','randomPeeResults'];
function integer(value,fallback,min,max){if(value===undefined||value===null)return fallback;if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw new ApiError(400,'Invalid statistics range or page.');return Number(value);}

export function createStatistics(db,admin,{now=Date.now}={}) { // Every device credential belongs to an administrator; optional self scope restricts its reach further.
  db.exec(`CREATE TABLE IF NOT EXISTS statistics_tokens(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES participants(id),name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('self','all')),token_hash TEXT NOT NULL UNIQUE,created INTEGER NOT NULL,revoked INTEGER);
    CREATE INDEX IF NOT EXISTS entries_statistics_date ON entries(substr(occurred_at,1,10),participant_id) WHERE deleted_at IS NULL;`);
  function owner(actor){admin.requireAdmin(actor);} // Demotion or disabling immediately removes every statistics permission, including self scope.
  function audit(actor,action,id){db.prepare('INSERT INTO admin_audit VALUES (?,?,?,?,?,?)').run(randomUUID(),actor,action,id,'{}',new Date(now()).toISOString());}
  function list(actor){owner(actor);return db.prepare('SELECT id,name,scope,created,revoked FROM statistics_tokens WHERE actor_id=? ORDER BY (revoked IS NOT NULL),created DESC,rowid DESC LIMIT 100').all(actor);} // Always show active connections, even after a long revocation history.
  function create(actor,input){
    owner(actor);const scope=input?.scope??'self';if(!['self','all'].includes(scope))throw new ApiError(400,'Choose self or all statistics.');
    if(typeof input?.name!=='string'||!input.name.trim()||input.name.length>80)throw new ApiError(400,'Name the device using up to 80 characters.');
    db.exec('BEGIN IMMEDIATE');try{
      if(db.prepare('SELECT count(*) AS n FROM statistics_tokens WHERE actor_id=? AND revoked IS NULL').get(actor).n>=10)throw new ApiError(409,'Revoke an unused statistics token first.');
      const id=randomUUID(),token='llstats_'+randomBytes(32).toString('base64url'),created=now(),name=input.name.trim();
      db.prepare('INSERT INTO statistics_tokens VALUES (?,?,?,?,?,?,NULL)').run(id,actor,name,scope,digest(token),created);
      audit(actor,'statistics-token-created',id);db.exec('COMMIT');return {id,name,scope,created,token};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function revoke(actor,input){
    owner(actor);if(typeof input?.id!=='string')throw new ApiError(400,'Choose a statistics token.');
    db.exec('BEGIN IMMEDIATE');try{
      const token=db.prepare('SELECT revoked FROM statistics_tokens WHERE id=? AND actor_id=?').get(input.id,actor);
      if(!token)throw new ApiError(404,'Statistics token not found.');
      if(token.revoked===null){db.prepare('UPDATE statistics_tokens SET revoked=? WHERE id=?').run(now(),input.id);audit(actor,'statistics-token-revoked',input.id);}
      db.exec('COMMIT');return {revoked:true};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function authorize(secret){
    if(typeof secret!=='string'||!/^llstats_[A-Za-z0-9_-]{43}$/.test(secret))throw new ApiError(401,'A statistics bearer token is required.');
    const token=db.prepare('SELECT actor_id,scope FROM statistics_tokens WHERE token_hash=? AND revoked IS NULL').get(digest(secret));
    if(!token)throw new ApiError(401,'Statistics token is invalid or revoked.');owner(token.actor_id);return token;
  }
  function participants(secret,query={}) { // Paginate the selector; a personal device can discover only its owner's label and ID.
    const token=authorize(secret),offset=integer(query.offset,0,0,100000000),limit=integer(query.limit,50,1,100);
    const filter=token.scope==='all'?'':' WHERE id=?',args=token.scope==='all'?[]:[token.actor_id];
    const total=db.prepare('SELECT count(*) AS n FROM participants'+filter).get(...args).n;
    const rows=db.prepare('SELECT id,label FROM participants'+filter+' ORDER BY id LIMIT ? OFFSET ?').all(...args,limit,offset);
    return {scope:token.scope,participants:rows,total,nextOffset:offset+rows.length<total?offset+rows.length:null};
  }
  function summary(secret,query={}) {
    const token=authorize(secret),scope=query.scope??'self',id=query.participantId??token.actor_id;
    if(!['self','all','participant'].includes(scope))throw new ApiError(400,'Choose self, participant or all statistics.');
    if(scope==='all'&&token.scope!=='all'||scope==='participant'&&id!==token.actor_id&&token.scope!=='all')throw new ApiError(403,'This token can read only its owner.');
    if(query.participantId!==undefined&&scope!=='participant')throw new ApiError(400,'Use scope=participant with participantId.');
    const participant=scope==='all'?null:db.prepare('SELECT id,label FROM participants WHERE id=?').get(scope==='self'?token.actor_id:id);
    if(scope!=='all'&&!participant)throw new ApiError(404,'Participant not found.');
    const today=analysisDay(now()),to=query.to??today,days=integer(query.days,7,1,31);
    if(typeof to!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(Date.parse(to+'T12:00:00Z'))||shiftDay(to,0)!==to||to<'2000-01-01'||to>today)throw new ApiError(400,'Choose a valid end date up to today in Los Angeles.');
    db.exec('BEGIN');try { // Read all days and chart stars from one consistent WAL snapshot.
      const data=aggregateAnalysis(db,shiftDay(to,1-days),to,now(),participant?.id??null);
      const totals=Object.fromEntries(fields.map(field=>[field,data.days.reduce((sum,day)=>sum+day[field],0)]));
      totals.categories=Object.fromEntries(Object.keys(data.days[0].categories).map(category=>[category,data.days.reduce((sum,day)=>sum+day.categories[category],0)]));
      db.exec('COMMIT');return {...data,scope:scope==='all'?'all':'participant',participant,timeZone:AI_ZONE,today,totals,
        limitations:'Saved tracking counts only; absent logs do not establish zero real-world events. No raw records, notes, wallet balances or AI reports. Individual drilldown includes the selected participant ID and label; everyone totals include disabled accounts.'};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {list,create,revoke,summary,participants};
}

export function statisticsApi(database,login,request,response,route) { // Devices can only read; cookies and wallet/report tokens confer no statistics permissions.
  const send=(status,value)=>{const text=JSON.stringify(value);response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(text),'Cache-Control':'no-store',Vary:'Authorization, Origin'});response.end(text);};
  try{
    if(request.headers['sec-fetch-site']==='cross-site'||request.headers.origin&&request.headers.origin!==login.origin)throw new ApiError(403,'This origin is not allowed.');
    if(request.method!=='GET'){response.setHeader('Allow','GET');throw new ApiError(405,'The statistics API is read-only.');}
    const secret=/^Bearer (llstats_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'')?.[1];
    const query=Object.fromEntries(new URL(request.url,login.origin).searchParams);
    if(!['summary','participants'].includes(route))throw new ApiError(404,'Statistics endpoint not found.');
    return send(200,database.statistics[route](secret,query));
  }catch(error){send(error.status??500,{error:error.status?error.message:'Statistics request failed. Please retry.'});}
}
