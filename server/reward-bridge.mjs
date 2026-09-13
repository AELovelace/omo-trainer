import {DatabaseSync,backup} from 'node:sqlite';
import {dirname,resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createEconomy} from './economy.mjs';
const eligible=new Set(['observation','wetting','diaper-change']);
const opaque=value=>createHash('sha256').update(value).digest('hex');

export function createRewardBridge(science,filename,options={}) { // A durable outbox crosses database boundaries without making chart or record saves depend on market availability.
  const marketPath=options.marketPath??(filename===':memory:'?':memory:':resolve(dirname(filename),'market.sqlite'));
  if(filename!==':memory:'&&marketPath!==':memory:'&&resolve(filename)===resolve(marketPath)) throw Error('Market and scientific data must use separate databases.');
  science.exec("CREATE TABLE IF NOT EXISTS reward_outbox(owner TEXT NOT NULL REFERENCES participants(id),asset TEXT NOT NULL,source_id TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,asset,source_id));");
  science.exec('CREATE INDEX IF NOT EXISTS reward_pending ON reward_outbox(delivered,owner);');
  let market=null,store=null;
  function open() { // Lazy opening lets scientific recording continue even while the market file is unavailable.
    if(store)return store;
    if(marketPath!==':memory:')mkdirSync(dirname(marketPath),{recursive:true,mode:0o700});
    market=new DatabaseSync(marketPath);
    try {
      if(market.prepare('PRAGMA user_version').get().user_version>6)throw Error('The market database requires a newer service version.');
      market.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100;');
      store=createEconomy(market,options.stickerCatalog,id=>Boolean(science.prepare('SELECT p.id FROM participants p LEFT JOIN participant_access a ON a.participant_id=p.id WHERE p.id=? AND COALESCE(a.disabled,0)=0').get(id)),options.stickerDuplicates);
      market.exec('PRAGMA user_version=6');
      return store;
    } catch(error) {market.close();market=null;store=null;throw error;}
  }
  function awardRecord(owner,entry) { // Persist only the source identity in the scientific transaction; the market never receives health payloads.
    if(eligible.has(entry?.kind))science.prepare("INSERT OR IGNORE INTO reward_outbox(owner,asset,source_id) VALUES (?,'sticker',?)").run(owner,entry.id);
  }
  function awardStars(owner,chart) { // Preserve one economic entitlement per chart cell independently of later chart edits.
    for(const cell of Object.keys(chart?.stars??{}))science.prepare("INSERT OR IGNORE INTO reward_outbox(owner,asset,source_id) VALUES (?,'star',?)").run(owner,cell);
  }
  function flush(owner=null) { // Commit market receipts before acknowledging delivery: crashes replay safely across the two SQLite files.
    const rewards=science.prepare('SELECT * FROM reward_outbox WHERE delivered=0'+(owner?' AND owner=?':'')+' LIMIT 1000').all(...(owner?[owner]:[]));
    if(!rewards.length)return 0;
    const economy=open();market.exec('BEGIN IMMEDIATE');
    try {
      for(const reward of rewards) {
        const source=opaque(reward.source_id);
        if(reward.asset==='sticker')economy.awardRecord(reward.owner,{id:source});
        else economy.awardStars(reward.owner,{stars:{[source]:true}});
      }
      market.exec('COMMIT');
    } catch(error) {market.exec('ROLLBACK');throw error;}
    science.exec('BEGIN IMMEDIATE');
    try {
      for(const reward of rewards)science.prepare('UPDATE reward_outbox SET delivered=1 WHERE owner=? AND asset=? AND source_id=?').run(reward.owner,reward.asset,reward.source_id);
      science.exec('COMMIT');
    } catch(error) {science.exec('ROLLBACK');throw error;}
    return rewards.length;
  }
  function tryFlush() { // An unavailable market never turns an already-saved observation into a failed sync response.
    try {flush();}catch { /* Durable entitlements retry on the next sync, timer or gallery visit. */ }
  }
  function stageExisting(owner) { // Backfill existing/imported records by stable ID without ever importing balances or market transactions.
    science.exec('BEGIN IMMEDIATE');
    try {
      for(const row of science.prepare("SELECT id,json_extract(payload_json,'$.kind') AS kind FROM entries e WHERE participant_id=? AND deleted_at IS NULL AND json_extract(payload_json,'$.kind') IN ('observation','wetting','diaper-change') AND NOT EXISTS(SELECT 1 FROM reward_outbox r WHERE r.owner=e.participant_id AND r.asset='sticker' AND r.source_id=e.id)").all(owner))awardRecord(owner,row);
      const chart=science.prepare('SELECT payload_json FROM growth_charts WHERE participant_id=?').get(owner);
      if(chart)awardStars(owner,JSON.parse(chart.payload_json));
      science.exec('COMMIT');
    } catch(error) {science.exec('ROLLBACK');throw error;}
  }
  return {
    awardRecord,awardStars,tryFlush,
    snapshot(owner) {
      stageExisting(owner);
      try {while(flush(owner)===1000) { /* Drain this account's backlog in bounded, replayable batches. */ }return open().snapshot(owner);}
      catch {throw Object.assign(new Error('The market is temporarily unavailable. Your scientific records and pending rewards are safe; try again shortly.'),{status:503});}
    },
    act(owner,input) { // A market action is independent of scientific transactions; ordinary validation errors retain their status.
      let economy;try {economy=open();}catch {throw Object.assign(new Error('The market is temporarily unavailable. Try again shortly.'),{status:503});}
      return economy.act(owner,input);
    },
    coins(method,...args) { // External wallet operations use only the market database and live account access checks.
      let economy;try {economy=open();}catch {throw Object.assign(new Error('The wallet is temporarily unavailable.'),{status:503});}
      return economy.coins[method](...args);
    },
    backup(destination) {open();return backup(market,destination);},
    close() {market?.close();market=null;store=null;},
  };
}
