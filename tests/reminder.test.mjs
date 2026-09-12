import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../server/database.mjs';
import {createApi} from '../server/api.mjs';
function fixture(path=':memory:') { // Synthetic identities keep reminder tests independent of live accounts.
  const db=openDatabase(path),admin=db.ensureParticipant('test','admin','Admin'),user=db.ensureParticipant('test','user','User');
  db.admin.bootstrap(admin.id);return {db,admin,user};
}
test('reminders persist, reject unauthorized/stale edits, and retry without extra audit events',()=>{
  const directory=mkdtempSync(join(tmpdir(),'little-log-reminder-')),path=join(directory,'science.sqlite');
  let {db,admin,user}=fixture(path);
  try {
    assert.deepEqual(db.admin.reminder(),{text:'',enabled:false,version:0,updatedAt:null});
    const input={text:'  Remember\n your notes!  ',enabled:true,version:0};
    assert.throws(()=>db.admin.saveReminder(user.id,input),e=>e.status===403);
    const value=db.admin.saveReminder(admin.id,input);
    assert.equal(value.text,'Remember your notes!');assert.equal(value.version,1);
    const count=db.admin.auditList(admin.id).length;
    assert.deepEqual(db.admin.saveReminder(admin.id,input),value);
    assert.equal(db.admin.auditList(admin.id).length,count);
    assert.throws(()=>db.admin.saveReminder(admin.id,{...input,text:'Stale overwrite'}),e=>e.status===409);
    for(const extra of [{text:' '.repeat(2)},{text:'x'.repeat(501)},{enabled:1},{version:-1}])
      assert.throws(()=>db.admin.saveReminder(admin.id,{...input,version:1,...extra}),e=>e.status===400);
    db.close();db=openDatabase(path);assert.deepEqual(db.admin.reminder(),value);
    assert.equal(db.admin.saveReminder(admin.id,{...value,enabled:false}).version,2);
    assert.equal(db.records(user.id).length,0,'Publishing does not create scientific records');
  }finally {db.close();rmSync(directory,{recursive:true,force:true});}
});
test('public reminder hides unpublished text; admin updates require an active admin session and CSRF',async()=>{
  const {db,admin,user}=fixture(),adminToken=db.createSession(admin.id),userToken=db.createSession(user.id);
  const login={origin:'',session:req=>db.session(req.headers.cookie)},api=createApi(db,login);
  const server=createServer((req,res)=>api(req,res,new URL(req.url,'http://localhost').pathname.slice(1)));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));login.origin='http://127.0.0.1:'+server.address().port;
  const get=(route,cookie)=>fetch(login.origin+'/'+route,{headers:cookie?{Cookie:cookie}:{}});
  const post=(cookie,csrf,input)=>fetch(login.origin+'/admin/reminder',{method:'POST',headers:{Cookie:cookie,Origin:login.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(input)});
  try {
    const draft={text:'Private draft',enabled:false,version:0};db.admin.saveReminder(admin.id,draft);
    const response=await get('reminder');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{text:'',enabled:false,version:1});
    assert.equal((await get('admin/reminder')).status,401);assert.equal((await get('admin/reminder',userToken)).status,403);
    assert.equal((await post(adminToken,'',{...draft,enabled:true,version:1})).status,403);
    assert.equal((await post(userToken,db.session(userToken).csrf,{...draft,enabled:true,version:1})).status,403);
    const saved=await post(adminToken,db.session(adminToken).csrf,{text:'Published <b>literally</b>',enabled:true,version:1});assert.equal(saved.status,200);
    assert.deepEqual(await (await get('reminder')).json(),{text:'Published <b>literally</b>',enabled:true,version:2});
    assert.equal((await post(adminToken,db.session(adminToken).csrf,{text:'Overwrite',enabled:true,version:1})).status,409);
    assert.equal((await (await get('admin/reminder',adminToken)).json()).version,2);
  }finally {await new Promise(done=>server.close(done));db.close();}
});
