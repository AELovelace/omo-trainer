import {protocolDay} from '../lib/training.js';
import {isObservation, isRoll, liquidTotal, WETTING_CATEGORIES} from '../lib/model.js';

export function dailyPayout(streak) { // The first three days pay coins; each subsequent day adds one more whole diamond.
  if(!Number.isSafeInteger(streak)||streak<1||streak>2147483647)throw Error('Invalid check-in streak.');
  return streak<=3?{asset:'coins',amount:streak*10}:{asset:'diamonds',amount:streak-3};
}
const shift=(day,offset)=>new Date(Date.parse(day+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10); // Calendar arithmetic stays independent of daylight-saving hour changes.
const validDay=day=>typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T12:00:00Z'))&&shift(day,0)===day;

export function createLoginBonuses(db,now=()=>Date.now()) { // Keep attendance and private daily statistics in the scientific database; only reward amounts cross to the market.
  db.exec(`CREATE TABLE IF NOT EXISTS login_bonus_accounts(owner TEXT PRIMARY KEY REFERENCES participants(id),time_zone TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_checkins(owner TEXT NOT NULL REFERENCES participants(id),day TEXT NOT NULL,streak INTEGER NOT NULL,asset TEXT NOT NULL,amount INTEGER NOT NULL,record_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner,day));`);
  function timeZone(owner) { // Pin the enrollment timezone on the first reward; later devices cannot move the daily boundary.
    const saved=db.prepare('SELECT time_zone FROM login_bonus_accounts WHERE owner=?').get(owner);
    if(saved)return saved.time_zone;
    return db.prepare("SELECT json_extract(payload_json,'$.timeZone') AS zone FROM entries WHERE participant_id=? AND deleted_at IS NULL AND json_extract(payload_json,'$.kind')='protocol' ORDER BY occurred_at,id LIMIT 1").get(owner)?.zone??'UTC';
  }
  function award(owner,recordId) { // Called inside the successful sync transaction, once any new eligible record has been accepted.
    const zone=timeZone(owner),instant=now(),day=protocolDay(instant,zone);
    db.prepare('INSERT OR IGNORE INTO login_bonus_accounts VALUES (?,?)').run(owner,zone);
    if(db.prepare('SELECT 1 FROM login_checkins WHERE owner=? AND day=?').get(owner,day))return;
    const previous=db.prepare('SELECT streak FROM login_checkins WHERE owner=? AND day=?').get(owner,shift(day,-1));
    const streak=(previous?.streak??0)+1,{asset,amount}=dailyPayout(streak);
    db.prepare('INSERT INTO login_checkins VALUES (?,?,?,?,?,?,?)').run(owner,day,streak,asset,amount,recordId,new Date(instant).toISOString());
    db.prepare('INSERT INTO reward_outbox(owner,asset,source_id,amount) VALUES (?,?,?,?)').run(owner,'login-'+asset,day,amount); // A durable daily receipt survives lost responses and an unavailable market.
    return {day,instant}; // Only a newly created daily check-in may queue a community broadcast.
  }
  function view(owner,{from,to}={}) { // Return only the signed-in account's requested calendar window and live statistics.
    const zone=timeZone(owner),today=protocolDay(now(),zone);
    from??=today.slice(0,7)+'-01';
    if(!validDay(from))throw Object.assign(Error('Choose a valid calendar start date.'),{status:400});
    to??=shift(new Date(Date.UTC(Number(from.slice(0,4)),Number(from.slice(5,7)),1)).toISOString().slice(0,10),-1);
    if(!validDay(from)||!validDay(to)||to<from||(Date.parse(to)-Date.parse(from))/86400000>41)throw Object.assign(Error('Choose a valid calendar range of at most 42 days.'),{status:400});
    const checkins=db.prepare("SELECT c.*,r.delivered FROM login_checkins c JOIN reward_outbox r ON r.owner=c.owner AND r.source_id=c.day AND r.asset='login-'||c.asset WHERE c.owner=? ORDER BY c.day").all(owner);
    const latest=checkins.at(-1),streak=latest&&latest.day>=shift(today,-1)&&latest.day<=today?latest.streak:0;
    const days=new Map();for(let day=from;day<=to;day=shift(day,1))days.set(day,{day,checkin:null,observations:0,wettings:0,changes:0,changedWettings:0,rolls:0,liquidsMl:0,categories:Object.fromEntries(WETTING_CATEGORIES.map(category=>[category,0])),entries:[]});
    for(const receipt of checkins)if(days.has(receipt.day))days.get(receipt.day).checkin={streak:receipt.streak,asset:receipt.asset,amount:receipt.amount,paid:Boolean(receipt.delivered)};
    for(const row of db.prepare('SELECT payload_json FROM entries WHERE participant_id=? AND deleted_at IS NULL').all(owner)) {
      const entry=JSON.parse(row.payload_json);if(!entry)continue;
      const day=days.get(protocolDay(entry.occurredAt,zone));if(!day)continue;
      if(isObservation(entry)){day.observations++;day.entries.push(entry);}
      if(entry.kind==='wetting'){day.wettings++;day.categories[entry.category]++;}
      if(entry.kind==='diaper-change'){day.changes++;day.changedWettings+=entry.wettingsCount;}
      if(isRoll(entry))day.rolls++;
    }
    for(const day of days.values()){day.liquidsMl=liquidTotal(day.entries);delete day.entries;}
    return {today,timeZone:zone,from,to,streak,longestStreak:Math.max(0,...checkins.map(day=>day.streak)),totalDays:checkins.length,checkedInToday:latest?.day===today,nextReward:dailyPayout(streak+1),earned:checkins.reduce((sum,day)=>{if(day.delivered)sum[day.asset]+=day.amount;return sum;},{coins:0,diamonds:0}),days:[...days.values()]};
  }
  function receipt(owner,id) { // Only the record that first qualified that day carries its daily-bonus message.
    const row=db.prepare("SELECT c.streak,c.asset,c.amount,r.delivered FROM login_checkins c JOIN reward_outbox r ON r.owner=c.owner AND r.source_id=c.day AND r.asset='login-'||c.asset WHERE c.owner=? AND c.record_id=? LIMIT 1").get(owner,id);
    return row?{streak:row.streak,asset:row.asset,amount:row.amount,paid:Boolean(row.delivered)}:null;
  }
  return {award,view,receipt};
}
