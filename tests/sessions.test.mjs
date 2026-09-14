import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createLogin} from '../server/login.mjs';
import {createApi} from '../server/api.mjs';
import {SESSION_IDLE_SECONDS,SESSION_MAX_SECONDS} from '../server/sessions.mjs';

const day=86400000;
function fixture(path=':memory:',initial=Date.now()) { // Fake server time makes month-long persistence and exact expiry boundaries fast and deterministic.
  let now=initial;const db=openDatabase(path,{sessions:{now:()=>now}});
  const admin=db.ensureParticipant('test','admin','Admin'),member=db.ensureParticipant('test','member','Member');db.admin.bootstrap(admin.id);
  return {db,admin,member,now:()=>now,set:value=>{now=value;},advance:ms=>{now+=ms;}};
}
function response(){const headers={};return {headers,getHeader:name=>headers[name],setHeader:(name,value)=>{headers[name]=value;}};}

test('active device sessions outlive an hour and renew daily up to an absolute six-month limit',()=>{
  const f=fixture();try{
    const start=f.now(),token=f.db.createSession(f.member.id),original=f.db.session(token);
    assert.equal(original.expiresAt,start+SESSION_IDLE_SECONDS*1000);
    f.advance(2*3600000);assert.equal(f.db.session(token,{renew:true}).expiresAt,original.expiresAt,'Polling within a day avoids extra writes');
    f.set(start+29*day);const renewed=f.db.session(token,{renew:true});assert.equal(renewed.expiresAt,start+59*day);assert.equal(renewed.csrf,original.csrf);
    for(let elapsed=58;elapsed<180;elapsed+=29){f.set(start+elapsed*day);assert.ok(f.db.session(token,{renew:true}));}
    f.set(start+179*day);assert.equal(f.db.session(token,{renew:true}).expiresAt,start+SESSION_MAX_SECONDS*1000);
    f.set(start+180*day);assert.equal(f.db.session(token,{renew:true}),null,'Activity cannot bypass the absolute lifetime');
  }finally{f.db.close();}
});

test('inactivity, sign-out, revocation and disabled access cannot be refreshed back into an authenticated session',()=>{
  const f=fixture();try{
    const idle=f.db.createSession(f.member.id);f.advance(30*day);assert.equal(f.db.session(idle,{renew:true}),null);
    const revoked=f.db.createSession(f.member.id);f.db.deleteSession(revoked);assert.equal(f.db.session(revoked,{renew:true}),null);
    const allRevoked=f.db.createSession(f.member.id);f.db.admin.updateUser(f.admin.id,{id:f.member.id,action:'revoke',version:0});assert.equal(f.db.session(allRevoked,{renew:true}),null);
    const disabled=f.db.createSession(f.member.id);f.db.admin.updateUser(f.admin.id,{id:f.member.id,action:'update',role:'participant',disabled:true,version:0});
    assert.equal(f.db.session(disabled,{renew:true}),null);assert.throws(()=>f.db.createSession(f.member.id),error=>error.status===403);
    f.db.admin.updateUser(f.admin.id,{id:f.member.id,action:'update',role:'participant',disabled:false,version:1});assert.equal(f.db.session(disabled,{renew:true}),null);
    for(const token of [null,undefined,'bad','x'.repeat(43)])assert.equal(f.db.session(token,{renew:true}),null);
  }finally{f.db.close();}
});

test('persistent sessions survive database reopen and legacy migration preserves only unexpired sessions',()=>{
  mkdirSync('artifacts',{recursive:true});const directory=mkdtempSync(resolve('artifacts/sessions-')),path=resolve(directory,'science.sqlite');let f=fixture(path);
  try{
    const time=f.now(),token=f.db.createSession(f.member.id),expired=f.db.createSession(f.member.id),member=f.member.id;f.db.close();
    let raw=new DatabaseSync(path);const key=createHash('sha256').update(token).digest('hex');
    assert.ok(!JSON.stringify(raw.prepare('SELECT * FROM app_sessions').all()).includes(token));
    raw.prepare('UPDATE app_sessions SET expires=? WHERE token_hash=?').run(time+600000,key);
    raw.prepare('UPDATE app_sessions SET expires=? WHERE token_hash<>?').run(time-1,key);raw.exec('ALTER TABLE app_sessions DROP COLUMN absolute_expires');raw.close();
    f=fixture(path,time);assert.equal(f.db.session(expired,{renew:true}),null);
    assert.equal(f.db.session(token,{renew:true}).expiresAt,time+30*day);f.db.close();
    f=fixture(path,time+2*day);assert.equal(f.db.session(token,{renew:true}).participant.id,member);
    const peer=openDatabase(path,{sessions:{now:()=>time+2*day}});peer.deleteSession(token);peer.close();assert.equal(f.db.session(token,{renew:true}),null);
    raw=new DatabaseSync(path);assert.equal(raw.prepare('PRAGMA table_info(app_sessions)').all().filter(column=>column.name==='absolute_expires').length,1);raw.close();
  }finally{f.db.close();}
});

test('login renews HttpOnly cookies with the exact remaining server lifetime and clears them on sign-out',()=>{
  const previous=process.env.PUBLIC_ORIGIN;process.env.PUBLIC_ORIGIN='https://tracker.example';const f=fixture();
  try{
    const login=createLogin(f.db,'/tracker/'),token=f.db.createSession(f.member.id),request={headers:{cookie:'__Secure-little_log='+token}};
    const out=response();out.setHeader('Set-Cookie',['other=preserved']);login.session(request,out);
    assert.equal(out.headers['Set-Cookie'][0],'other=preserved');assert.match(out.headers['Set-Cookie'][1],/Path=\/tracker\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
    f.advance(2*day);const later=response();login.session(request,later);assert.match(later.headers['Set-Cookie'][0],/Max-Age=2592000;/);
    const noSecret=response();assert.equal(login.session({headers:{}},noSecret),null);assert.equal(noSecret.headers['Set-Cookie'],undefined);
    login.logout(request,out);assert.match(out.headers['Set-Cookie'],/Max-Age=0; Secure$/);assert.equal(f.db.session(token,{renew:true}),null);
  }finally{f.db.close();if(previous===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=previous;}
});

test('real API requests refresh the cookie, preserve CSRF and identity isolation, and cannot renew after logout',async()=>{
  const f=fixture(),login=createLogin(f.db,'/tracker/'),api=createApi(f.db,login);
  const server=createServer((req,res)=>void api(req,res,new URL(req.url,login.origin).pathname.slice('/tracker/api/'.length)));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const base='http://127.0.0.1:'+server.address().port+'/tracker/api/';
  const token=f.db.createSession(f.member.id),cookie='little_log='+token,headers={Cookie:cookie};
  try{
    f.advance(2*day);const res=await fetch(base+'session',{headers});assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/Max-Age=2592000/);
    const data=await res.json();assert.equal(data.participant.id,f.member.id);assert.ok(!JSON.stringify(data).includes(token));
    assert.equal((await fetch(base+'admin/users',{headers})).status,403);
    const cross=await fetch(base+'session',{headers:{...headers,Origin:'https://evil.invalid'}});assert.equal(cross.status,403);assert.equal(cross.headers.get('set-cookie'),null);
    assert.equal((await fetch(base+'logout',{method:'POST',headers:{...headers,Origin:login.origin,'Content-Type':'application/json'},body:'{}'})).status,403);
    const logout=await fetch(base+'logout',{method:'POST',headers:{...headers,Origin:login.origin,'Content-Type':'application/json','X-CSRF-Token':data.csrf},body:'{}'});
    assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
    const replay=await fetch(base+'session',{headers});assert.equal(replay.status,401);assert.equal(replay.headers.get('set-cookie'),null);
  }finally{await new Promise(done=>server.close(done));f.db.close();}
});
