import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
import {createCoinApiStore,coinApps} from '../server/coin-api-store.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
function fixture(path=':memory:') {const db=openDatabase(path,{stickerCatalog:[]}),a=db.ensureParticipant('test','a','Alice'),b=db.ensureParticipant('test','b','Bob');return {db,a,b,call:(method,...args)=>db.economy.coins(method,...args)};}
function connect(call,user,scope='wallet:read wallet:write') {const device=call('begin',{client_id:'lidollquest',scope},'test');call('approve',user.id,{user_code:device.user_code,approve:true});return call('token',{client_id:'lidollquest',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:device.device_code}).access_token;}
test('game wallet operations are relative, scoped, integer, idempotent, isolated and persisted outside science',()=>{
  const dir=mkdtempSync(join(tmpdir(),'coin-api-')),path=join(dir,'science.sqlite');let {db,a,b}=fixture(path);const call=(method,...args)=>db.economy.coins(method,...args);
  try {
    const token=connect(call,a),other=connect(call,b),read=connect(call,a,'wallet:read');
    const earn={request_id:'reward-1',kind:'credit',amount:100};const receipt=call('operation',token,earn);
    assert.equal(receipt.balance,100);assert.deepEqual(call('operation',token,earn),receipt);
    assert.throws(()=>call('operation',token,{...earn,amount:101}),e=>e.status===409);
    assert.equal(call('balance',other).balance,0);assert.equal(call('balance',token).balance,100);
    assert.throws(()=>call('operation',read,{...earn,request_id:'no-scope'}),e=>e.status===403);
    for(const amount of [0,-1,0.5,'1',2147483648])assert.throws(()=>call('operation',token,{...earn,request_id:'invalid',amount}),e=>e.status===400);
    const purchase={request_id:'purchase-1',kind:'debit',amount:40};assert.equal(call('operation',token,purchase).balance,60);
    assert.throws(()=>call('operation',token,{...purchase,request_id:'overdraw',amount:61}),e=>e.status===409);
    assert.equal(call('balance',token).balance,60);
    const refund={request_id:'refund-1',kind:'refund',original_id:'purchase-1'};assert.equal(call('operation',token,refund).balance,100);
    assert.throws(()=>call('operation',token,{...refund,request_id:'refund-2'}),e=>e.status===409);
    assert.throws(()=>call('operation',other,refund),e=>e.status===409);
    assert.equal(db.records(a.id).length,0);assert.equal(db.growthChart(a.id).chart,null);
    db.close();db=openDatabase(path,{stickerCatalog:[]});assert.equal(call('balance',token).balance,100);assert.deepEqual(call('operation',token,earn),receipt);
    const market=new DatabaseSync(join(dir,'market.sqlite'));assert.equal(market.prepare('PRAGMA user_version').get().user_version,9);
    const grant=market.prepare('SELECT token_hash FROM coin_grants LIMIT 1').get();assert.notEqual(grant.token_hash,token);assert.equal(grant.token_hash.length,64);
    assert.equal(market.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='entries'").get().n,0);market.close();
    const links=call('connections',a.id);call('revoke',b.id,links[0].id);assert.equal(call('connections',a.id).length,2);
    for(const link of links)call('revoke',a.id,link.id);assert.throws(()=>call('balance',token),e=>e.status===401);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('device grants enforce consent, scope, expiration, polling backoff and account disablement',()=>{
  const db=new DatabaseSync(':memory:');let time=100000,enabled=true;
  const store=createCoinApiStore(db,()=>({coins:0}),()=>{},()=>enabled,coinApps(),()=>time);
  try {
    const input={client_id:'lidollquest',scope:'wallet:read'};
    assert.throws(()=>store.begin({...input,scope:'science:read'},'test'),e=>e.code==='invalid_scope');
    const d=store.begin(input,'test'),poll={client_id:'lidollquest',device_code:d.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'};
    assert.throws(()=>store.token(poll),e=>e.code==='authorization_pending');
    assert.throws(()=>store.token(poll),e=>e.code==='slow_down');time+=10000;
    assert.equal(store.inspect('alice',d.user_code).name,'LiDollQuest');store.approve('alice',{user_code:d.user_code,approve:true});
    const result=store.token(poll);assert.equal(result.scope,'wallet:read');assert.throws(()=>store.token(poll),e=>e.code==='expired_token');
    enabled=false;assert.throws(()=>store.balance(result.access_token),e=>e.status===401);enabled=true;
    time+=30*86400000;assert.throws(()=>store.balance(result.access_token),e=>e.status===401);
    const denied=store.begin(input,'test');store.approve('alice',{user_code:denied.user_code,approve:false});assert.throws(()=>store.token({...poll,device_code:denied.device_code}),e=>e.code==='access_denied');
    const expired=store.begin(input,'test');time+=600001;assert.throws(()=>store.inspect('alice',expired.user_code),e=>e.status===400);
  }finally{db.close();}
});
test('external API uses bearer tokens and explicit origins; browser consent requires session plus CSRF',async()=>{
  const {db,a,b,call}=fixture(),session=db.createSession(a.id);const login={origin:'',session:req=>db.session(req.headers.cookie)};
  const api=createApi(db,login),server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice('/tracker/api/'.length)));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));login.origin='http://127.0.0.1:'+server.address().port;
  const base=login.origin+'/tracker/api/',external=base+'lidollcoin/v1/';
  const post=(url,input,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
  try {
    const device=await post(external+'device?client_id=lidollquest',{});assert.equal(device.status,200);const d=await device.json();assert.equal(d.verification_uri,login.origin+'/tracker/coins/');
    assert.equal((await post(external+'device?client_id=lidollquest',{}, {Origin:'https://evil.example'})).status,403);
    assert.equal((await post(base+'coin-approve',{user_code:d.user_code,approve:true},{Cookie:session,Origin:login.origin})).status,403);
    const csrf=db.session(session).csrf;assert.equal((await post(base+'coin-approve',{user_code:d.user_code,approve:true},{Cookie:session,Origin:login.origin,'X-CSRF-Token':csrf})).status,200);
    const result=await (await post(external+'token?client_id=lidollquest',{device_code:d.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'})).json();
    const headers={Authorization:'Bearer '+result.access_token};
    assert.equal((await fetch(external+'wallet?client_id=lidollquest',{headers:{Cookie:session}})).status,401);
    const wallet=await fetch(external+'wallet?client_id=lidollquest',{headers});assert.equal(wallet.status,200);assert.equal(wallet.headers.get('cache-control'),'no-store');
    const payment=await post(external+'operations?client_id=lidollquest',{kind:'credit',amount:25,request_id:'api-reward',owner:b.id},headers);assert.equal(payment.status,200);
    assert.equal(call('balance',result.access_token).balance,25);assert.equal(db.economy.snapshot(b.id).wallet.coins,0);
    assert.equal((await fetch(base+'session',{headers})).status,401,'Game token cannot retrieve scientific records');
    const allowed=await fetch(external+'wallet?client_id=lidollquest',{headers:{...headers,Origin:login.origin}});assert.equal(allowed.headers.get('access-control-allow-origin'),login.origin);assert.equal(allowed.headers.get('access-control-allow-credentials'),null);
    assert.equal((await post(external+'revoke?client_id=lidollquest',{},headers)).status,200);assert.equal((await fetch(external+'wallet?client_id=lidollquest',{headers})).status,401);
  }finally{await new Promise(done=>server.close(done));db.close();}
});

test('game earning caps survive new grants and refunds do not create extra credit capacity',()=>{
  const {db,a,call}=fixture();try {
    const token=connect(call,a);call('operation',token,{kind:'credit',amount:1000000,request_id:'daily-cap'});
    const fresh=connect(call,a);assert.throws(()=>call('operation',fresh,{kind:'credit',amount:1,request_id:'above-cap'}),e=>e.code==='daily_limit');
    call('operation',token,{kind:'debit',amount:10,request_id:'spend'});call('operation',token,{kind:'refund',original_id:'spend',request_id:'refund'});
    assert.throws(()=>call('operation',fresh,{kind:'credit',amount:1,request_id:'still-above'}),e=>e.code==='daily_limit');
    assert.equal(call('balance',token).balance,1000000);
  }finally{db.close();}
});
