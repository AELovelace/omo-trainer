import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createLittlepottchiBridge} from '../server/littlepottchi-bridge.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:'), now = Date.parse('2026-09-15T14:00:00Z'); t.after(() => db.close());
  db.exec(`CREATE TABLE participants(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT);
    CREATE TABLE participant_access(participant_id TEXT,disabled INTEGER);
    CREATE TABLE notification_preferences(owner TEXT,time_zone TEXT,quiet_start INTEGER,quiet_end INTEGER);
    CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,owner TEXT,payload TEXT);
    CREATE TABLE ai_analysis_jobs(id TEXT,status TEXT,finished INTEGER,input TEXT);
    INSERT INTO participants VALUES ('owner','https://id.example','subject'),('other','https://other.example','subject');
    INSERT INTO notification_preferences VALUES ('owner','UTC',0,0),('other','UTC',0,0);`);
  db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?)').run('push-owner','owner',JSON.stringify({endpoint:'push-owner'}));
  db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?)').run('push-other','other',JSON.stringify({endpoint:'push-other'}));
  const snapshot = {scope:'All participants, including disabled accounts.',days:[{date:'2026-09-15',wettings:12,activeParticipants:2,
    randomPeeResults:99}],capturedAt:new Date(now).toISOString(),limitations:'No raw histories'};
  db.prepare('INSERT INTO ai_analysis_jobs VALUES (?,?,?,?)').run('saved-report','completed',now,JSON.stringify(snapshot));
  const f = {db,now,calls:[],sent:[],events:[],loseAck:false};
  f.event = (kind = 'leak') => ({id:randomUUID(),sequence:1,recipient:{issuer:'https://id.example',subject:'subject'},kind,created:now,expires:now + 86400000});
  f.options = {baseUrl:'https://bot.example/littlepottchi/integration/v1/',token:'fixture-bridge-secret-'.repeat(3),configured:true,
    localBlock:() => ({hour:14}),send:async (sub,payload) => { f.sent.push({sub,payload}); },
    fetch:async (url,options) => {
      const body = options.body ? JSON.parse(options.body) : null; f.calls.push({url:String(url),options,body});
      if (String(url).endsWith('/analysis')) return Response.json({accepted:true});
      if (String(url).endsWith('/events/ack')) {
        if (f.loseAck) throw Error('Lost acknowledgement');
        f.events = f.events.filter(e => !body.ids.includes(e.id)); return Response.json({ok:true});
      }
      return Response.json({events:f.events,nextAfter:f.events.at(-1)?.sequence || 0,more:false});
    }};
  f.bridge = () => createLittlepottchiBridge(db,f.options);
  return f;
} // Every network request and push transport is synthetic; use the same native SQLite API as Little Log.

test('Little Log exports only the latest completed saved aggregate and routes game pushes by exact identity', async t => {
  const f = fixture(t); f.events.push(f.event());
  f.db.prepare('INSERT INTO ai_analysis_jobs VALUES (?,?,?,?)').run('running-newer','running',f.now + 1,'{}');
  await f.bridge().tick(f.now);
  const upload = f.calls.find(c => c.url.endsWith('/analysis'));
  assert.deepEqual(upload.body,{reportId:'saved-report',finished:f.now,days:[{date:'2026-09-15',wettings:12,activeParticipants:2}]});
  assert.equal(upload.options.redirect,'error'); assert.ok(upload.options.signal);
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].sub.endpoint,'push-owner');
  assert.equal(f.sent[0].payload.kind,'littlepottchi'); assert.equal(f.sent[0].payload.need,'leak');
  assert.equal(JSON.stringify(f.sent).includes('subject'),false); assert.equal(f.events.length,0);
});

test('messy diaper events use the existing identity-bound push path', async t => {
  const f = fixture(t); f.events.push(f.event('mess'));
  await f.bridge().tick(f.now);
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].payload.need,'mess');
  assert.equal(f.sent[0].sub.endpoint,'push-owner'); assert.equal(f.events.length,0);
});

test('quiet hours defer, expired/disabled recipients skip, and the other issuer receives nothing', async t => {
  const f = fixture(t), bridge = f.bridge(); f.events.push(f.event());
  f.db.exec("UPDATE notification_preferences SET quiet_start=13,quiet_end=16 WHERE owner='owner'");
  await bridge.tick(f.now); assert.equal(f.sent.length,0); assert.equal(f.events.length,1);
  f.db.exec("UPDATE notification_preferences SET quiet_start=0,quiet_end=0 WHERE owner='owner'; INSERT INTO participant_access VALUES ('owner',1)");
  await bridge.tick(f.now); assert.equal(f.sent.length,0); assert.equal(f.events.length,0);
  f.db.exec('DELETE FROM participant_access'); f.events.push({...f.event(),expires:f.now});
  await bridge.tick(f.now); assert.equal(f.sent.length,0);
});

test('a lost feed acknowledgement or uncertain push never duplicates delivery after restart', async t => {
  const f = fixture(t); f.events.push(f.event()); f.loseAck = true;
  const first = f.bridge(); await first.tick(f.now); assert.equal(f.sent.length,1); assert.ok(first.status().lastError);
  f.loseAck = false; await f.bridge().tick(f.now); assert.equal(f.sent.length,1); assert.equal(f.events.length,0);
  f.events.push(f.event('wet'));
  f.options.send = async () => { f.sent.push('uncertain'); throw Error('Push response lost'); };
  f.loseAck = true; await f.bridge().tick(f.now); f.loseAck = false; await f.bridge().tick(f.now);
  assert.equal(f.sent.length,2);
});

test('expired push endpoints are removed, polling is bounded and concurrent ticks are serialized', async t => {
  const f = fixture(t); f.events.push(f.event());
  f.options.send = async () => { throw Object.assign(Error('gone'),{statusCode:410}); };
  const bridge = f.bridge(); await Promise.all([bridge.tick(f.now),bridge.tick(f.now)]);
  assert.equal(f.calls.filter(c => c.url.endsWith('/analysis')).length,1);
  assert.equal(f.db.prepare("SELECT 1 FROM push_subscriptions WHERE owner='owner'").get(),undefined);
  assert.ok(f.db.prepare("SELECT 1 FROM push_subscriptions WHERE owner='other'").get());
  assert.equal(f.events.length,0);
});

test('bridge is opt-in configuration, rejects unsafe URLs, and imports analysis without push keys', async t => {
  const f = fixture(t);
  assert.equal(createLittlepottchiBridge(f.db,{baseUrl:'',token:''}).status().configured,false);
  for (const baseUrl of ['http://bot.example/littlepottchi/integration/v1/','https://user:secret@bot.example/littlepottchi/integration/v1/',
    'https://bot.example/littlepottchi/integration/v1/?token=bad']) assert.throws(() => createLittlepottchiBridge(f.db,{...f.options,baseUrl}));
  f.options.configured = false; await f.bridge().tick(f.now);
  assert.equal(f.calls.length,1); assert.ok(f.calls[0].url.endsWith('/analysis')); assert.equal(f.sent.length,0);
});
