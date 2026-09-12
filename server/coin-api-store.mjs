import {randomBytes,randomUUID,createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(status,message,code='invalid_request')=>{throw Object.assign(new Error(message),{status,code});};
const whole=(value,max=2147483647)=>{if(!Number.isSafeInteger(value)||value<1||value>max)fail(400,'Use a positive whole number within the allowed limit.');return value;};
export function coinApps(raw=process.env.LIDOLLCOIN_APPS) { // App registration is deployment configuration; no shared app secret belongs in a distributed game.
  const apps=raw?JSON.parse(raw):[{id:'lidollquest',name:'LiDollQuest',origins:[],dailyLimit:1000000}];
  if(!Array.isArray(apps)||!apps.length)throw Error('LIDOLLCOIN_APPS must be a non-empty JSON array.');
  const seen=new Set();
  return apps.map(app=>{
    if(!/^[a-z0-9_-]{1,64}$/.test(app.id)||seen.has(app.id)||typeof app.name!=='string'||!app.name.trim()||app.name.length>80)throw Error('Invalid or duplicate LiDollCoin app.');
    seen.add(app.id);
    if(!Number.isSafeInteger(app.dailyLimit)||app.dailyLimit<1||app.dailyLimit>2147483647)throw Error('Configure each app dailyLimit.');
    if(!Array.isArray(app.origins)||app.origins.some(origin=>{try {const url=new URL(origin);return url.origin!==origin||(url.protocol!=='https:'&&!(process.env.NODE_ENV==='test'&&url.hostname==='127.0.0.1'));}catch{return true;}}))throw Error('App origins must be exact HTTPS origins.');
    return app;
  });
}
export function createCoinApiStore(db,wallet,adjust,enabled,apps=coinApps(),now=()=>Date.now()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coin_devices(device_hash TEXT PRIMARY KEY,user_code TEXT UNIQUE NOT NULL,client TEXT NOT NULL,scope TEXT NOT NULL,owner TEXT,expires INTEGER NOT NULL,last_poll INTEGER NOT NULL DEFAULT 0,interval_ms INTEGER NOT NULL DEFAULT 5000,state TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE IF NOT EXISTS coin_grants(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,client TEXT NOT NULL,scope TEXT NOT NULL,created_at INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS coin_game_operations(client TEXT NOT NULL,owner TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(client,owner,id));
    CREATE TABLE IF NOT EXISTS coin_refunds(client TEXT NOT NULL,owner TEXT NOT NULL,original TEXT NOT NULL,PRIMARY KEY(client,owner,original));
    CREATE INDEX IF NOT EXISTS coin_game_daily ON coin_game_operations(owner,client,created_at);
    CREATE TABLE IF NOT EXISTS coin_rate_limits(key TEXT PRIMARY KEY,starts INTEGER NOT NULL,count INTEGER NOT NULL);
  `);
  function app(id) {const value=apps.find(item=>item.id===id);if(!value)fail(401,'Unknown external app.','invalid_client');return value;} // Resolve only pre-registered app IDs.
  function atomic(fn) {db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}} // Receipts, ledger changes and balances commit together.
  function rate(key,limit) { // Persistent short-window limits bound public code creation and verification guesses across restarts.
    const time=now();db.prepare('DELETE FROM coin_rate_limits WHERE starts<?').run(time-600000);
    db.prepare('INSERT INTO coin_rate_limits VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,time);
    if(db.prepare('SELECT count FROM coin_rate_limits WHERE key=?').get(key).count>limit)fail(429,'Please wait before trying again.','slow_down');
  }
  function begin(input,address) { // The game holds a high-entropy device secret; the player confirms a separate human-readable code.
    const client=app(input?.client_id);rate('device:'+client.id+':'+hash(address),60);
    const scopes=String(input.scope??'wallet:read wallet:write').split(' ').filter(Boolean);
    if(!scopes.length||scopes.some(s=>!['wallet:read','wallet:write'].includes(s)))fail(400,'Unsupported scope.','invalid_scope');
    db.prepare('DELETE FROM coin_devices WHERE expires<?').run(now());
    if(db.prepare('SELECT COUNT(*) AS n FROM coin_devices WHERE client=?').get(client.id).n>=1000)fail(429,'This app has too many pending connections.','slow_down');
    const device=randomBytes(32).toString('base64url'),code=randomBytes(6).toString('hex').toUpperCase();
    db.prepare('INSERT INTO coin_devices(device_hash,user_code,client,scope,expires) VALUES (?,?,?,?,?)').run(hash(device),code,client.id,[...new Set(scopes)].join(' '),now()+600000);
    return {device_code:device,user_code:code.slice(0,6)+'-'+code.slice(6),expires_in:600,interval:5};
  }
  function device(code) {const value=db.prepare('SELECT * FROM coin_devices WHERE user_code=?').get(String(code??'').replaceAll('-','').toUpperCase());if(!value||value.expires<=now()||value.state!=='pending')fail(400,'This connection code has expired or was already used.');return value;}
  function inspect(owner,code) { // Preview contains only the registered app and requested permissions, never a bearer credential.
    rate('verify:'+owner,30);const value=device(code),client=app(value.client);
    return {client_id:client.id,name:client.name,scope:value.scope,daily_limit:client.dailyLimit,user_code:value.user_code};
  }
  function approve(owner,input) {
    if(!enabled(owner))fail(403,'Account access is disabled.');
    rate('verify:'+owner,30);
    if(typeof input?.approve!=='boolean')fail(400,'Choose Allow or Deny.');
    return atomic(()=>{const value=device(input.user_code);app(value.client);db.prepare('UPDATE coin_devices SET owner=?,state=? WHERE device_hash=?').run(owner,input.approve?'approved':'denied',value.device_hash);return {ok:true};});
  }
  function token(input) { // OAuth-style device polling obeys interval backoff and consumes an approved code once.
    app(input?.client_id);
    if(input.grant_type!=='urn:ietf:params:oauth:grant-type:device_code'||typeof input.device_code!=='string'||input.device_code.length>100)fail(400,'Invalid device grant.');
    const value=db.prepare('SELECT * FROM coin_devices WHERE device_hash=? AND client=?').get(hash(input.device_code),input.client_id);
    if(!value||value.expires<=now()||value.state==='consumed')fail(400,'Connect the app again.','expired_token');
    if(value.last_poll&&now()<value.last_poll+value.interval_ms){db.prepare('UPDATE coin_devices SET interval_ms=interval_ms+5000,last_poll=? WHERE device_hash=?').run(now(),value.device_hash);fail(400,'Poll less frequently.','slow_down');}
    db.prepare('UPDATE coin_devices SET last_poll=? WHERE device_hash=?').run(now(),value.device_hash);
    if(value.state==='pending')fail(400,'Waiting for account approval.','authorization_pending');
    if(value.state==='denied')fail(400,'Connection declined.','access_denied');
    if(!enabled(value.owner))fail(403,'Account access is disabled.','access_denied');
    return atomic(()=>{
      const changed=db.prepare("UPDATE coin_devices SET state='consumed' WHERE device_hash=? AND state='approved'").run(value.device_hash).changes;
      if(!changed)fail(400,'Connect the app again.','expired_token');
      const secret=randomBytes(32).toString('base64url'),expires=now()+30*86400000;
      db.prepare('INSERT INTO coin_grants VALUES (?,?,?,?,?,?,?,0)').run(randomUUID(),hash(secret),value.owner,value.client,value.scope,now(),expires);
      return {access_token:secret,token_type:'Bearer',expires_in:2592000,scope:value.scope};
    });
  }
  function grant(secret,scope) { // Tokens cannot select another owner, expose scientific records, or use any scientific API.
    if(typeof secret!=='string'||secret.length>100)fail(401,'A valid access token is required.','invalid_token');
    const value=db.prepare('SELECT * FROM coin_grants WHERE token_hash=? AND revoked=0 AND expires>?').get(hash(secret),now());
    if(!value||!enabled(value.owner))fail(401,'Reconnect this app to your account.','invalid_token');
    app(value.client);if(scope&&!value.scope.split(' ').includes(scope))fail(403,'This connection lacks the required permission.','insufficient_scope');return value;
  }
  function balance(secret) {const value=grant(secret,'wallet:read');return {currency:'LiDollCoin',balance:wallet(value.owner).coins,account_id:hash(value.client+':'+value.owner)};}
  function connections(owner) {return db.prepare('SELECT id,client,scope,created_at AS createdAt,expires FROM coin_grants WHERE owner=? AND revoked=0 AND expires>? ORDER BY created_at DESC').all(owner,now()).map(value=>({...value,name:apps.find(a=>a.id===value.client)?.name??value.client}));}
  function revoke(owner,id) {db.prepare('UPDATE coin_grants SET revoked=1 WHERE owner=? AND id=?').run(owner,id);return {ok:true};}
  function operation(secret,input) { // Apply relative game earnings/spending; never accept a saved absolute balance.
    const identity=grant(secret,'wallet:write'),client=app(identity.client);
    if(!input||!/^[A-Za-z0-9_-]{1,80}$/.test(input.request_id??'')||!['credit','debit','refund'].includes(input.kind))fail(400,'Supply a request_id and credit, debit or refund kind.');
    if(input.kind==='refund'&&!/^[A-Za-z0-9_-]{1,80}$/.test(input.original_id??''))fail(400,'Supply the original debit request ID.');
    const amount=input.kind==='refund'?0:whole(input.amount);
    const fingerprint=hash(JSON.stringify([input.kind,amount,input.kind==='refund'?input.original_id:null]));
    return atomic(()=>{
      grant(secret,'wallet:write');
      const receipt=db.prepare('SELECT * FROM coin_game_operations WHERE client=? AND owner=? AND id=?').get(client.id,identity.owner,input.request_id);
      if(receipt){if(receipt.fingerprint!==fingerprint)fail(409,'This request ID already describes another operation.');return JSON.parse(receipt.result);}
      let delta=input.kind==='debit'?-amount:amount;
      if(input.kind==='credit') {
        const day=Math.floor(now()/86400000)*86400000;
        const credited=db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM coin_game_operations WHERE client=? AND owner=? AND kind='credit' AND created_at>=?").get(client.id,identity.owner,day).n;
        if(credited+amount>client.dailyLimit)fail(429,'This app daily earning limit has been reached. Retry tomorrow.','daily_limit');
      }
      if(input.kind==='refund') {
        const original=db.prepare("SELECT amount FROM coin_game_operations WHERE client=? AND owner=? AND id=? AND kind='debit'").get(client.id,identity.owner,input.original_id);
        if(!original)fail(409,'The original debit was not found.');
        if(db.prepare('SELECT 1 FROM coin_refunds WHERE client=? AND owner=? AND original=?').get(client.id,identity.owner,input.original_id))fail(409,'This purchase has already been refunded.');
        delta=original.amount;db.prepare('INSERT INTO coin_refunds VALUES (?,?,?)').run(client.id,identity.owner,input.original_id);
      }
      const operationId=randomUUID();adjust(identity.owner,'coins',delta,operationId,'game '+input.kind+': '+client.id);
      const result={operation_id:operationId,request_id:input.request_id,kind:input.kind,amount:Math.abs(delta),balance:wallet(identity.owner).coins,currency:'LiDollCoin'};
      db.prepare('INSERT INTO coin_game_operations VALUES (?,?,?,?,?,?,?,?)').run(client.id,identity.owner,input.request_id,input.kind,Math.abs(delta),now(),fingerprint,JSON.stringify(result));return result;
    });
  }
  return {app,begin,inspect,approve,token,grant,balance,connections,revoke,operation};
}
