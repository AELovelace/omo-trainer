import { openDatabase } from '../server/database.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [command, argument] = process.argv.slice(2);
const valid = ['list', 'export-json', 'export-csv', 'export-charts-json', 'backup', 'backup-market'];
if (!valid.includes(command) || (command !== 'list' && !argument)) {
  console.log('Usage: node scripts/admin.mjs list | export-json <file> | export-csv <file> | export-charts-json <file> | backup <new-file> | backup-market <new-file>');
  process.exit(1);
}
const database = openDatabase();
try {
  if (command === 'list') console.log(JSON.stringify(database.list(), null, 2));
  else {
    const destination = resolve(argument);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (command === 'backup' || command === 'backup-market') {
      await writeFile(destination, '', { flag: 'wx', mode: 0o600 }); // Refuses to overwrite an existing backup or the live database.
      if(command==='backup-market') await database.economy.backup(destination);
      else await database.backup(destination);
    } else if (command === 'export-charts-json') {
      await writeFile(destination, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), charts: database.exportCharts() }, null, 2), { flag: 'wx', mode: 0o600 }); // Keep chart exports private and never overwrite existing files.
    } else {
      const rows = database.exportRows();
      const columns = ['participant_id', 'entry_id', 'occurred_at', 'local_date', 'liquids_ml', 'position', 'diaper_number', 'wettings_count', 'probability', 'result', 'source', 'edited', 'version', 'created_at', 'updated_at', 'kind', 'category', 'rolled_at', 'rolled_result', 'protocol_version', 'time_zone', 'last_failure_at', 'liquids_mode', 'desperation', 'base_probability', 'probability_modifier', 'roll_rule_version', 'desperation_mode', 'last_failure_desperation_mode'];
      const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`; // Exports only generated IDs and validated fields, never labels or secret codes.
      const output = command === 'export-json' ? JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), entries: rows }, null, 2)
        : '\uFEFF' + [columns, ...rows.map(row => columns.map(column => row[column]))].map(row => row.map(cell).join(',')).join('\r\n');
      await writeFile(destination, output, { flag: 'wx', mode: 0o600 });
    }
    console.log(`Saved ${command} to ${destination}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { database.close(); }
