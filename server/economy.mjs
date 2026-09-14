import {createCoinApiStore} from './coin-api-store.mjs';
import {randomInt,randomUUID,createHash} from 'node:crypto';
import {stickerCatalog} from './sticker-catalog.mjs';
import {mergeStickerDuplicates} from './sticker-duplicates.mjs';

const BANK='stickerbank', MAX=2147483647;
function fail(status,message) { throw Object.assign(new Error(message),{status}); } // Return safe actionable errors through the authenticated API.
function integer(value,min=1,max=MAX) { if(!Number.isSafeInteger(value)||value<min||value>max) fail(400,'Use a whole number within the allowed range.'); return value; }

export function createEconomy(db,catalog=stickerCatalog(),enabled=()=>true,duplicates) { // Market balances and exchanges use their own database, separate from scientific records.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sticker_types(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sticker_aliases(alias TEXT PRIMARY KEY REFERENCES sticker_types(id),canonical TEXT NOT NULL REFERENCES sticker_types(id));
    CREATE TABLE IF NOT EXISTS economy_wallets(owner TEXT PRIMARY KEY,participant_id TEXT UNIQUE,coins INTEGER NOT NULL DEFAULT 0 CHECK(typeof(coins)='integer' AND coins BETWEEN 0 AND 2147483647),stars INTEGER NOT NULL DEFAULT 0 CHECK(typeof(stars)='integer' AND stars BETWEEN 0 AND 2147483647));
    CREATE TABLE IF NOT EXISTS sticker_inventory(owner TEXT NOT NULL REFERENCES economy_wallets(owner),sticker TEXT NOT NULL REFERENCES sticker_types(id),quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 0 AND 2147483647),PRIMARY KEY(owner,sticker));
    CREATE TABLE IF NOT EXISTS sticker_rewards(owner TEXT NOT NULL REFERENCES economy_wallets(owner),entry_id TEXT NOT NULL,kind TEXT NOT NULL,sticker TEXT REFERENCES sticker_types(id),created_at TEXT NOT NULL,PRIMARY KEY(owner,entry_id));
    CREATE TABLE IF NOT EXISTS roll_coin_rewards(owner TEXT NOT NULL REFERENCES economy_wallets(owner),source_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount IN (5,10)),created_at TEXT NOT NULL,PRIMARY KEY(owner,source_id));
    CREATE TABLE IF NOT EXISTS performance_rewards(owner TEXT NOT NULL REFERENCES economy_wallets(owner),source_id TEXT NOT NULL,amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 1 AND 2147483647),created_at TEXT NOT NULL,PRIMARY KEY(owner,source_id));
    CREATE TABLE IF NOT EXISTS star_rewards(owner TEXT NOT NULL REFERENCES economy_wallets(owner),cell TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner,cell));
    CREATE TABLE IF NOT EXISTS economy_ledger(id INTEGER PRIMARY KEY,operation TEXT NOT NULL,owner TEXT NOT NULL REFERENCES economy_wallets(owner),asset TEXT NOT NULL,delta INTEGER NOT NULL CHECK(typeof(delta)='integer'),reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sticker_listings(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES economy_wallets(owner),sticker TEXT NOT NULL REFERENCES sticker_types(id),quantity INTEGER NOT NULL CHECK(quantity>0),want_sticker TEXT REFERENCES sticker_types(id),want_quantity INTEGER NOT NULL CHECK(want_quantity>0),status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sticker_trades(id INTEGER PRIMARY KEY,operation TEXT NOT NULL,sticker TEXT NOT NULL REFERENCES sticker_types(id),seller TEXT NOT NULL,buyer TEXT NOT NULL,quantity INTEGER NOT NULL,coins INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sticker_reward_type ON sticker_rewards(owner,sticker);
    CREATE INDEX IF NOT EXISTS sticker_open_listing ON sticker_listings(status,created_at,id);
    CREATE INDEX IF NOT EXISTS sticker_owner_listing ON sticker_listings(owner,status,sticker);
    CREATE INDEX IF NOT EXISTS sticker_trade_activity ON sticker_trades(sticker,created_at);
    CREATE INDEX IF NOT EXISTS economy_ledger_owner ON economy_ledger(owner,id);
    CREATE TABLE IF NOT EXISTS economy_requests(owner TEXT NOT NULL REFERENCES economy_wallets(owner),id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO economy_wallets(owner) VALUES (?)').run(BANK);
    db.exec('INSERT OR IGNORE INTO performance_rewards SELECT owner,source_id,amount,created_at FROM roll_coin_rewards'); // Carry old receipts forward without changing balances or historical ledger entries.
    db.exec('UPDATE sticker_types SET active=0');
    for(const sticker of catalog) db.prepare('INSERT INTO sticker_types VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,active=1').run(sticker.id,sticker.name,sticker.url);
    mergeStickerDuplicates(db,catalog,adjust,duplicates);
    catalog=catalog.filter(type=>!db.prepare('SELECT 1 FROM sticker_aliases WHERE alias=?').get(type.id));
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}

  function wallet(owner) { // Participant-backed wallets cannot be selected by a browser-supplied account ID.
    db.prepare('INSERT OR IGNORE INTO economy_wallets(owner,participant_id) VALUES (?,?)').run(owner,owner===BANK?null:owner);
    return db.prepare('SELECT coins,stars FROM economy_wallets WHERE owner=?').get(owner);
  }
  function balance(owner,asset) { // Stickers and currencies both use bounded integer quantities.
    if(asset==='coins'||asset==='stars') return wallet(owner)[asset];
    return db.prepare('SELECT quantity FROM sticker_inventory WHERE owner=? AND sticker=?').get(owner,asset)?.quantity??0;
  }
  function adjust(owner,asset,delta,operation,reason) { // A ledger entry and its materialized balance always commit together.
    wallet(owner);
    const next=balance(owner,asset)+delta;
    if(!Number.isSafeInteger(next)||next<0||next>MAX) fail(409,'Insufficient balance or account balance limit reached.');
    if(asset==='coins'||asset==='stars') db.prepare('UPDATE economy_wallets SET '+asset+'=? WHERE owner=?').run(next,owner);
    else db.prepare('INSERT INTO sticker_inventory VALUES (?,?,?) ON CONFLICT(owner,sticker) DO UPDATE SET quantity=excluded.quantity').run(owner,asset,next);
    db.prepare('INSERT INTO economy_ledger(operation,owner,asset,delta,reason,created_at) VALUES (?,?,?,?,?,?)').run(operation,owner,asset,delta,reason,new Date().toISOString());
  }
  function awardRecord(owner,entry) { // Unique entry IDs prevent edits, tombstone restores and upload retries from minting extra stickers.
    if(!entry) return;
    wallet(owner);
    db.prepare('INSERT OR IGNORE INTO sticker_rewards VALUES (?,?,?,NULL,?)').run(owner,entry.id,'record',new Date().toISOString());
    assignPending(owner);
  }
  function awardPerformanceBonus(owner,source,amount) { // The bridge transaction commits one receipt, balance credit and ledger entry together; only an opaque source and amount cross databases.
    integer(amount);
    wallet(owner);
    const inserted=db.prepare('INSERT OR IGNORE INTO performance_rewards VALUES (?,?,?,?)').run(owner,source,amount,new Date().toISOString()).changes;
    if(inserted) {
      const messages=['a little sparkle for your day!','a pocketful of sunshine!','a little hooray for you!','a sprinkle of happy!'];
      adjust(owner,'coins',amount,'performance:'+source,'Performance bonus: '+messages[randomInt(messages.length)]);
    }
  }
  function assignPending(owner) { // Missing assets leave durable pending rewards that resolve when the collection becomes available.
    if(!catalog.length) return;
    for(const reward of db.prepare('SELECT entry_id FROM sticker_rewards WHERE owner=? AND sticker IS NULL').all(owner)) {
      const sticker=catalog[randomInt(catalog.length)].id;
      db.prepare('UPDATE sticker_rewards SET sticker=? WHERE owner=? AND entry_id=?').run(sticker,owner,reward.entry_id);
      adjust(owner,sticker,1,'reward:'+reward.entry_id,'record reward');
    }
  }
  function awardStars(owner,chart) { // A date/row cell earns once for its lifetime; clearing and restoring progress cannot earn it twice.
    wallet(owner);
    for(const cell of Object.keys(chart?.stars??{})) {
      const inserted=db.prepare('INSERT OR IGNORE INTO star_rewards VALUES (?,?,?)').run(owner,cell,new Date().toISOString()).changes;
      if(inserted) adjust(owner,'stars',1,'star:'+cell,'chart star reward');
    }
  }
  function price(sticker) { // Each distinct participant counts once per sticker in a rolling 30-day window, including completed bank trades.
    const since=new Date(Date.now()-30*86400000).toISOString();
    const traders=db.prepare('SELECT COUNT(*) AS n FROM (SELECT seller AS person FROM sticker_trades WHERE (sticker=? OR sticker IN (SELECT alias FROM sticker_aliases WHERE canonical=?)) AND created_at>=? UNION SELECT buyer FROM sticker_trades WHERE (sticker=? OR sticker IN (SELECT alias FROM sticker_aliases WHERE canonical=?)) AND created_at>=?) WHERE person<>?').get(sticker,sticker,since,sticker,sticker,since,BANK).n;
    return {traders,price:10+Math.min(990,traders)};
  }
  function listing(id) { // Disabled sellers cannot receive new trades; their escrow remains intact for later restoration.
    const row=db.prepare('SELECT * FROM sticker_listings WHERE id=?').get(id);
    if(!row||row.status!=='open'||!enabled(row.owner)) fail(409,'This listing is no longer available.');return row;
  }
  function trade(operation,sticker,seller,buyer,quantity,coins) { // Public activity reveals sticker demand without exposing anyone's log records or account names.
    db.prepare('INSERT INTO sticker_trades(operation,sticker,seller,buyer,quantity,coins,created_at) VALUES (?,?,?,?,?,?,?)').run(operation,sticker,seller,buyer,quantity,coins,new Date().toISOString());
  }
  function act(owner,input) { // Receipts make double taps and lost-response retries safe; all exchange legs run under one SQLite write lock.
    if(!input||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId)) fail(400,'Supply a unique request ID.');
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      wallet(owner);
      const receipt=db.prepare('SELECT * FROM economy_requests WHERE owner=? AND id=?').get(owner,input.requestId);
      if(receipt) {
        if(receipt.hash!==fingerprint) fail(409,'This request ID was already used for a different exchange.');
        db.exec('COMMIT');return JSON.parse(receipt.result);
      }
      if(input.action==='bank-buy') fail(400,'Buying from the stickerbank is no longer available. Buy from other users in the community market.'); // Older clients cannot create purchases; completed receipts above still resolve safely.
      const canonical=asset=>typeof asset==='string'?(db.prepare('SELECT canonical FROM sticker_aliases WHERE alias=?').get(asset)?.canonical??asset):asset;
      input={...input,sticker:canonical(input.sticker),wantSticker:canonical(input.wantSticker)}; // Old clients retain retry receipts while new actions use the merged design.
      const operation=randomUUID();let result={ok:true,operation};
      if(['bank-sell','list'].includes(input.action)) {
        if(typeof input.sticker!=='string') fail(400,'Choose a sticker.');
        const type=db.prepare('SELECT * FROM sticker_types WHERE id=?').get(input.sticker);
        if(!type) fail(400,'Unknown sticker.');
        const quantity=integer(input.quantity,1,10000);
        if(input.action==='list') {
          if(db.prepare("SELECT COUNT(*) AS n FROM sticker_listings WHERE owner=? AND status='open'").get(owner).n>=100) fail(409,'Cancel or complete an open listing before adding another.');
          const want=input.wantSticker??null,amount=integer(input.wantQuantity);
          if(want!==null && (typeof want!=='string'||want===input.sticker||!db.prepare('SELECT 1 FROM sticker_types WHERE id=?').get(want))) fail(400,'Choose a different sticker for a swap.');
          adjust(owner,input.sticker,-quantity,operation,'listing escrow');
          db.prepare("INSERT INTO sticker_listings VALUES (?,?,?,?,?,?,'open',?)").run(operation,owner,input.sticker,quantity,want,amount,new Date().toISOString());
          result.listingId=operation;
        } else {
          const quote=price(input.sticker).price;
          if(input.expectedPrice!==quote) fail(409,'The market rate changed. Review the refreshed price before trading.');
          const total=integer(quote*quantity);
          if(balance(owner,input.sticker)<quantity) fail(409,'You do not own enough available stickers.');
          if(balance(BANK,'coins')<total) {
            const issued=db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM economy_ledger WHERE owner=? AND reason='bank coin issuance'").get(BANK).n;
            const mint=total-balance(BANK,'coins');
            if(!Number.isSafeInteger(issued+mint)) fail(409,'The market coin issuance limit has been reached.');
            adjust(BANK,'coins',mint,operation,'bank coin issuance');
          }
          adjust(owner,input.sticker,-quantity,operation,'bank exchange');adjust(BANK,input.sticker,quantity,operation,'bank exchange');
          adjust(BANK,'coins',-total,operation,'bank exchange');adjust(owner,'coins',total,operation,'bank exchange');
          trade(operation,input.sticker,owner,BANK,quantity,total);result.coins=total;
        }
      } else if(input.action==='cancel'||input.action==='accept') {
        if(typeof input.listingId!=='string') fail(400,'Choose a listing.');
        const offer=listing(input.listingId);
        if(input.action==='cancel') {
          if(offer.owner!==owner) fail(403,'Only the seller can cancel this listing.');
          adjust(owner,offer.sticker,offer.quantity,operation,'escrow returned');
        } else {
          if(offer.owner===owner) fail(400,'You cannot trade with your own listing.');
          const payment=offer.want_sticker??'coins';
          adjust(owner,payment,-offer.want_quantity,operation,'market payment');
          adjust(offer.owner,payment,offer.want_quantity,operation,'market payment');
          adjust(owner,offer.sticker,offer.quantity,operation,'escrow delivered');
          trade(operation,offer.sticker,offer.owner,owner,offer.quantity,payment==='coins'?offer.want_quantity:0);
          if(offer.want_sticker) trade(operation,offer.want_sticker,owner,offer.owner,offer.want_quantity,0);
        }
        db.prepare('UPDATE sticker_listings SET status=? WHERE id=?').run(input.action==='cancel'?'cancelled':'sold',offer.id);
      } else fail(400,'Unknown market action.');
      db.prepare('INSERT INTO economy_requests VALUES (?,?,?,?)').run(owner,input.requestId,fingerprint,JSON.stringify(result));
      db.exec('COMMIT');return result;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  function snapshot(owner) { // The gallery returns only this owner's wallet/history plus anonymous public listings and bank stock.
    db.exec('BEGIN IMMEDIATE');
    try {
      wallet(owner);assignPending(owner);
      const types=db.prepare('SELECT * FROM sticker_types WHERE id NOT IN (SELECT alias FROM sticker_aliases) ORDER BY name,id').all().map(type=>({...type,...price(type.id),quantity:balance(owner,type.id),bankQuantity:balance(BANK,type.id),earned:db.prepare('SELECT COUNT(*) AS n FROM sticker_rewards WHERE owner=? AND sticker=?').get(owner,type.id).n,escrow:db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM sticker_listings WHERE owner=? AND sticker=? AND status='open'").get(owner,type.id).n}));
      const offers=db.prepare("SELECT * FROM sticker_listings WHERE status='open' AND (owner=? OR id IN (SELECT id FROM sticker_listings WHERE status='open' ORDER BY created_at DESC,id LIMIT 500)) ORDER BY created_at DESC,id").all(owner).filter(row=>enabled(row.owner)).map(row=>({id:row.id,mine:row.owner===owner,sticker:row.sticker,quantity:row.quantity,wantSticker:row.want_sticker,wantQuantity:row.want_quantity,createdAt:row.created_at}));
      const data={wallet:wallet(owner),bank:{...wallet(BANK),issuedCoins:db.prepare("SELECT COALESCE(SUM(delta),0) AS n FROM economy_ledger WHERE owner=? AND reason='bank coin issuance'").get(BANK).n},types,aliases:db.prepare('SELECT a.alias AS id,t.name,a.canonical FROM sticker_aliases a JOIN sticker_types t ON t.id=a.alias').all(),listings:offers,pendingRewards:db.prepare('SELECT COUNT(*) AS n FROM sticker_rewards WHERE owner=? AND sticker IS NULL').get(owner).n,history:db.prepare('SELECT id,asset,delta,reason,created_at AS createdAt FROM economy_ledger WHERE owner=? ORDER BY id DESC LIMIT 100').all(owner)};
      db.exec('COMMIT');return data;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  function recordReward(owner,source) { // Read this record's original award, even after later rewards or sticker sales.
    db.exec('BEGIN IMMEDIATE');
    try {
      assignPending(owner);
      const reward=db.prepare('SELECT t.id,t.name,t.url FROM sticker_rewards r JOIN sticker_types t ON t.id=r.sticker WHERE r.owner=? AND r.entry_id=?').get(owner,source);
      db.exec('COMMIT');return reward?{...reward,quantity:1}:null;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  return {awardRecord,awardPerformanceBonus,awardStars,snapshot,act,recordReward,coins:createCoinApiStore(db,wallet,adjust,enabled)};
}
