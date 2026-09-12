import {createHash} from 'node:crypto';
const id=path=>createHash('sha256').update(path).digest('hex').slice(0,24);
// Visually confirmed duplicate scans; keep the first published ID for each design.
export const STICKER_DUPLICATES=[13,14,15,16].map(number=>({path:number+'.png',alias:id(number+'.png'),canonical:id((number-12)+'.png')}));

export function mergeStickerDuplicates(db,catalog,adjust,duplicates=STICKER_DUPLICATES) { // Called inside market initialization's transaction so holdings and escrow move together.
  const available=new Set(catalog.map(type=>type.id));
  for(const {alias,canonical} of duplicates) {
    if(!available.has(canonical)||!db.prepare('SELECT 1 FROM sticker_types WHERE id=?').get(alias)||db.prepare('SELECT 1 FROM sticker_aliases WHERE alias=?').get(alias))continue;
    const operation='merge:'+alias;
    for(const row of db.prepare('SELECT owner,quantity FROM sticker_inventory WHERE sticker=? AND quantity>0').all(alias)) {
      adjust(row.owner,alias,-row.quantity,operation,'duplicate sticker merged');
      adjust(row.owner,canonical,row.quantity,operation,'duplicate sticker merged');
    }
    db.prepare('UPDATE sticker_rewards SET sticker=? WHERE sticker=?').run(canonical,alias);
    db.prepare("UPDATE sticker_listings SET sticker=? WHERE sticker=? AND status='open'").run(canonical,alias);
    db.prepare("UPDATE sticker_listings SET want_sticker=? WHERE want_sticker=? AND status='open'").run(canonical,alias);
    db.prepare('INSERT INTO sticker_aliases VALUES (?,?)').run(alias,canonical);
  }
  for(const offer of db.prepare("SELECT * FROM sticker_listings WHERE status='open' AND sticker=want_sticker").all()) {
    adjust(offer.owner,offer.sticker,offer.quantity,'merge-cancel:'+offer.id,'duplicate swap cancelled'); // Return escrow when a swap would now exchange the same design.
    db.prepare("UPDATE sticker_listings SET status='cancelled' WHERE id=?").run(offer.id);
  }
  db.exec('UPDATE sticker_types SET active=0 WHERE id IN (SELECT alias FROM sticker_aliases)');
}
