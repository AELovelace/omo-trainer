import { openDatabase, databasePath } from '../server/database.mjs';
import { checkedUrl } from '../auth/config.mjs';
import { writeFile } from 'node:fs/promises';

const [previous, next, confirmation] = process.argv.slice(2);
if (!previous || !next || confirmation !== '--same-accounts') throw new Error('Usage: node scripts/migrate-issuer.mjs <old-issuer> <new-issuer> --same-accounts. Use only when the same identity database and stable subjects move hosts; stop the tracker first.');
for (const value of [previous, next]) {
  const url = checkedUrl(value);
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Use exact HTTPS issuer origins without a trailing slash.');
}
const db = openDatabase();
try {
  const destination = databasePath() + '.before-issuer-' + Date.now() + '.sqlite';
  await writeFile(destination, '', { flag: 'wx', mode: 0o600 }); // Never overwrite the live database or an existing recovery copy.
  await db.backup(destination);
  const count = db.migrateIssuer(previous, next);
  console.log(`Migrated ${count} participants without changing their IDs, records, or charts. Backup: ${destination}`);
} finally { db.close(); }
