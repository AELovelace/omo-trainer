import {createFriends} from './friends.mjs';
import {createNotifications} from './notifications.mjs';
import {createAnalysisStore} from './ai-analysis.mjs';
import {createStatistics} from './statistics.mjs';
import {createSessions} from './sessions.mjs';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateEntry, MAX_ENTRIES } from '../lib/model.js';
import { validateGrowthChart } from './growth-chart.mjs';
import { createAdminStore } from './admin-store.mjs';
import { createRewardBridge } from './reward-bridge.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'); // Stores only a digest of session secrets and retry payloads.
export const databasePath = () => resolve(process.env.DATA_DIR ?? 'data', 'little-log.sqlite');

export class ApiError extends Error { // Carries expected client errors without exposing database internals in API responses.
  constructor(status, message) { super(message); this.status = status; }
}

export function openDatabase(filename = databasePath(), options = {}) { // Opens a persistent, transactional database outside the public asset allowlist.
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (db.prepare('PRAGMA user_version').get().user_version > 2) { db.close(); throw new Error('This database was created by a newer app version.'); }
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(issuer, subject)
    );
    CREATE TABLE IF NOT EXISTS entries (
      participant_id TEXT NOT NULL REFERENCES participants(id), id TEXT NOT NULL,
      occurred_at TEXT, liquids_ml INTEGER, position TEXT, diaper_number INTEGER,
      wettings_count INTEGER, probability INTEGER, result TEXT, source TEXT, edited INTEGER,
      version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      PRIMARY KEY (participant_id, id)
    );
    CREATE INDEX IF NOT EXISTS entries_by_date ON entries(occurred_at, participant_id);
    CREATE TABLE IF NOT EXISTS mutations (
      participant_id TEXT NOT NULL REFERENCES participants(id), id TEXT NOT NULL,
      request_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (participant_id, id)
    );
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES participants(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (
      token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL
    );
  `);
  if (db.prepare('PRAGMA user_version').get().user_version < 2) { // Adds structured events without rewriting legacy snapshots or mutation receipts.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('PRAGMA user_version').get().user_version < 2) db.exec('ALTER TABLE entries ADD COLUMN payload_json TEXT; PRAGMA user_version = 2;');
      db.exec('COMMIT'); // Rechecks under the write lock if an administrator and service start concurrently.
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }

  db.exec(`CREATE TABLE IF NOT EXISTS growth_charts (
    participant_id TEXT PRIMARY KEY REFERENCES participants(id), payload_json TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS growth_chart_mutations (
    participant_id TEXT NOT NULL REFERENCES participants(id), id TEXT NOT NULL, request_hash TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(participant_id, id)
  );`); // Add charts beside observations without changing participant IDs or existing records.

  function growthChart(participantId) { // Look up the chart through the same account as the Chrysalis observation file.
    const row = db.prepare('SELECT * FROM growth_charts WHERE participant_id = ?').get(participantId);
    return row ? { chart: JSON.parse(row.payload_json), version: row.version, updatedAt: row.updated_at } : { chart: null, version: 0, updatedAt: null };
  }

  function saveGrowthChart(participantId, input) { // Check versions and retain receipts so retries cannot overwrite another device's work.
    if (!input || !Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0 || typeof input.mutationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.mutationId)) throw new ApiError(400, 'Invalid chart version or mutation ID.');
    let chart;
    try { chart = validateGrowthChart(input.chart); } catch (error) { throw new ApiError(400, error.message); }
    const fingerprint = hash(JSON.stringify({ baseVersion: input.baseVersion, chart }));
    db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = db.prepare('SELECT * FROM growth_chart_mutations WHERE participant_id = ? AND id = ?').get(participantId, input.mutationId);
      if (receipt && receipt.request_hash !== fingerprint) throw new ApiError(400, 'A chart retry ID was reused for different data.');
      if (receipt) { db.exec('COMMIT'); return { chart, version: receipt.version, updatedAt: receipt.updated_at }; }
      if (growthChart(participantId).version !== input.baseVersion) throw new ApiError(409, 'Your Chrysalis file has a newer chart. Choose which version to keep.');
      const version = input.baseVersion + 1, updatedAt = new Date().toISOString();
      db.prepare(`INSERT INTO growth_charts VALUES (?, ?, ?, ?) ON CONFLICT(participant_id)
        DO UPDATE SET payload_json=excluded.payload_json, version=excluded.version, updated_at=excluded.updated_at`).run(participantId, JSON.stringify(chart), version, updatedAt);
      economy.awardStars(participantId, chart); // Credit new star cells in the same transaction as chart progress.
      db.prepare('INSERT INTO growth_chart_mutations VALUES (?, ?, ?, ?, ?)').run(participantId, input.mutationId, fingerprint, version, updatedAt);
      db.exec('COMMIT');
      economy.tryFlush(); // Deliver rewards after the scientific transaction has committed.
      return { chart, version, updatedAt };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function migrateIssuer(previous, next) { // Explicit administrator migration for the same auth account database; never merge usernames or collisions.
    if (previous === next) throw new Error('Choose two different issuers.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = db.prepare('SELECT COUNT(*) AS count FROM participants WHERE issuer = ?').get(previous).count;
      if (!count) throw new Error('No participants use the previous issuer.');
      const collision = db.prepare('SELECT 1 FROM participants a JOIN participants b ON a.subject=b.subject WHERE a.issuer=? AND b.issuer=? LIMIT 1').get(previous, next);
      if (collision) throw new Error('Both issuers already have a participant for the same subject. Resolve the account collision before migrating.');
      db.prepare('UPDATE participants SET issuer=? WHERE issuer=?').run(next, previous);
      db.exec('DELETE FROM app_sessions; DELETE FROM login_attempts;');
      db.exec('COMMIT');
      return count;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function ensureParticipant(issuer, subject, label) { // Maps an OIDC identity to an app-specific pseudonym, never to a browser-supplied participant ID.
    const name = String(label || 'Participant').slice(0, 80);
    let id;db.exec('BEGIN IMMEDIATE'); // Account creation and its one-time starting balance entitlement commit together, including concurrent first sign-ins.
    try {
      const existing=db.prepare('SELECT id FROM participants WHERE issuer=? AND subject=?').get(issuer,subject);
      id=existing?.id??randomUUID();
      db.prepare(`INSERT INTO participants (id, label, issuer, subject, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(issuer, subject) DO UPDATE SET label=excluded.label`).run(id,name,issuer,subject,new Date().toISOString());
      if(!existing)economy.awardRegistration(id);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    economy.tryFlush(); // A market outage leaves the durable grant pending without preventing registration or sign-in.
    return { id, label: name };
  }

  function saveLogin(token, payload) { // Keeps PKCE verifier, state, and nonce off the browser and expires unfinished logins after ten minutes.
    db.prepare('DELETE FROM login_attempts WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO login_attempts VALUES (?, ?, ?)').run(hash(token), JSON.stringify(payload), Date.now() + 600000);
  }

  function takeLogin(token) { // Consumes an authorization attempt once so callbacks cannot be replayed.
    if (!token) return null;
    const row = db.prepare('DELETE FROM login_attempts WHERE token_hash = ? RETURNING payload, expires').get(hash(token));
    return row && row.expires > Date.now() ? JSON.parse(row.payload) : null;
  }

  function recordFromRow(row) { // Converts typed SQL columns to the shared API schema; deletions expose only a tombstone.
    return {
      id: row.id, version: row.version,
      entry: row.deleted_at ? null : row.payload_json ? validateEntry(JSON.parse(row.payload_json)) : validateEntry({
        id: row.id, occurredAt: row.occurred_at, liquidsMl: row.liquids_ml, position: row.position,
        diaperNumber: row.diaper_number, wettingsCount: row.wettings_count, probability: row.probability,
        result: row.result, source: row.source, edited: Boolean(row.edited),
      }),
    };
  }

  function records(participantId) { // Returns only the authenticated participant's records, including deletion versions for offline clients.
    return db.prepare('SELECT * FROM entries WHERE participant_id = ? ORDER BY created_at, rowid').all(participantId).map(recordFromRow);
  }

  function sync(participantId, changes) { // Commits validated mutations with idempotent retries and optimistic per-entry version checks.
    if (!Array.isArray(changes) || changes.length > 100) throw new ApiError(400, 'Send at most 100 changes per sync request.');
    let clean;
    try {
      clean = changes.map(change => {
        if (!change || !/^[A-Za-z0-9_-]{1,80}$/.test(change.id ?? '') || !/^[A-Za-z0-9_-]{1,80}$/.test(change.mutationId ?? '') ||
          typeof change.id !== 'string' || typeof change.mutationId !== 'string' || !Number.isSafeInteger(change.baseVersion) || change.baseVersion < 0) throw new Error('Invalid change ID or version.');
        const entry = change.entry === null ? null : validateEntry(change.entry);
        if (entry && entry.id !== change.id) throw new Error('Entry ID does not match its change ID.');
        return { id: change.id, mutationId: change.mutationId, baseVersion: change.baseVersion, entry };
      });
      if (new Set(clean.map(change => change.mutationId)).size !== clean.length) throw new Error('Duplicate mutation IDs in a batch.');
    } catch (error) { throw new ApiError(400, error.message); }
    const ack = [], conflicts = new Map();
    let checkinRecord=null; // Only a newly accepted observation, wetting, change or roll can qualify for today's bonus.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of clean) {
        const fingerprint = hash(JSON.stringify(change));
        const receipt = db.prepare('SELECT request_hash FROM mutations WHERE participant_id = ? AND id = ?').get(participantId, change.mutationId);
        if (receipt) {
          if (receipt.request_hash !== fingerprint) throw new ApiError(400, 'A retry ID was reused for a different change.');
          ack.push(change.mutationId);
          continue;
        }
        if (conflicts.has(change.id)) continue; // Later offline edits cannot bypass an earlier conflict on the same entry.
        const row = db.prepare('SELECT * FROM entries WHERE participant_id = ? AND id = ?').get(participantId, change.id);
        if ((row?.version ?? 0) !== change.baseVersion) {
          conflicts.set(change.id, row ? recordFromRow(row) : { id: change.id, version: 0, entry: null });
          continue;
        }
        if (!row && db.prepare('SELECT COUNT(*) AS total FROM entries WHERE participant_id = ?').get(participantId).total >= MAX_ENTRIES) throw new ApiError(400, 'This participant has reached the 50,000-record storage limit. Ask the organizer to archive the dataset.');
        const entry = change.entry, now = new Date().toISOString();
        db.prepare(`INSERT INTO entries (participant_id, id, occurred_at, liquids_ml, position, diaper_number, wettings_count, probability, result, source, edited, version, created_at, updated_at, deleted_at, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(participant_id, id) DO UPDATE SET occurred_at=excluded.occurred_at, liquids_ml=excluded.liquids_ml,
          position=excluded.position, diaper_number=excluded.diaper_number, wettings_count=excluded.wettings_count,
          probability=excluded.probability, result=excluded.result, source=excluded.source, edited=excluded.edited,
          version=excluded.version, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, payload_json=excluded.payload_json`).run(
          participantId, change.id, entry?.occurredAt ?? null, entry?.liquidsMl ?? null, entry?.position ?? null,
          entry?.diaperNumber ?? null, entry?.wettingsCount ?? null, entry?.probability ?? null, entry?.result ?? null,
          entry?.source ?? null, entry ? Number(entry.edited ?? false) : null, change.baseVersion + 1, now, now, entry ? null : now,
          entry ? JSON.stringify(entry) : null,
        );
        if(!entry)friends.revokeRecord(participantId,change.id); // Deleting a source record also revokes friend access before the sync commits.
        if (!row && entry) economy.awardRecord(participantId, entry); // Award only after the server accepts a new record.
        if(!row&&['observation','wetting','diaper-change','roll'].includes(entry?.kind))checkinRecord??=entry.id;
        db.prepare('INSERT INTO mutations (participant_id, id, request_hash, created_at) VALUES (?, ?, ?, ?)').run(participantId, change.mutationId, fingerprint, now);
        ack.push(change.mutationId);
      }
      if(checkinRecord)notifications.community.queue(participantId,economy.awardDailyCheckin(participantId,checkinRecord)); // Enrollment from the complete batch is available before pinning its timezone.
      const snapshot = records(participantId);
      db.exec('COMMIT');
      economy.tryFlush(); // Market failure leaves durable rewards pending without failing this saved sync.
      return { ack, conflicts: [...conflicts.values()], records: snapshot };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function exportRows() { // Exposes analysis columns to a server-local administrator without credentials or public export endpoints.
    return db.prepare(`SELECT participant_id, id AS entry_id, occurred_at, substr(occurred_at, 1, 10) AS local_date,
      liquids_ml, position, diaper_number, wettings_count, probability, result, source, edited, version, created_at, updated_at,
      COALESCE(json_extract(payload_json, '$.kind'), 'roll') AS kind, json_extract(payload_json, '$.category') AS category,
      json_extract(payload_json, '$.rolledAt') AS rolled_at, json_extract(payload_json, '$.rolledResult') AS rolled_result,
      json_extract(payload_json, '$.protocolVersion') AS protocol_version, json_extract(payload_json, '$.timeZone') AS time_zone,
      json_extract(payload_json, '$.lastFailureAt') AS last_failure_at,
      CASE WHEN json_extract(payload_json, '$.kind') IS NULL THEN 'cumulative'
        ELSE json_extract(payload_json, '$.liquidsMode') END AS liquids_mode, json_extract(payload_json, '$.desperation') AS desperation,
      json_extract(payload_json, '$.baseProbability') AS base_probability, json_extract(payload_json, '$.probabilityModifier') AS probability_modifier,
      json_extract(payload_json, '$.rollRuleVersion') AS roll_rule_version,
      json_extract(payload_json, '$.desperationMode') AS desperation_mode,
      json_extract(payload_json, '$.lastFailureDesperationMode') AS last_failure_desperation_mode
      FROM entries WHERE deleted_at IS NULL ORDER BY participant_id, occurred_at, id`).all();
  }

  const admin = createAdminStore(db, records, growthChart); // Add app access controls without migrating or rewriting observation payloads.
  const sessions=createSessions(db,admin,options.sessions); // Persistent device sessions retain live access checks and server-side revocation.
  const economy = createRewardBridge(db, filename, options); // Queue rewards here; all balances and market trades live in market.sqlite.
  const friends=createFriends(db,recordFromRow,{onRemove:(a,b)=>notifications.community.restrictPair(a,b)});
  const notifications=createNotifications(db,records,{...options.notifications,areFriends:friends.accepted});
  const aiAnalysis=createAnalysisStore(db,admin,options.aiAnalysis); // Only admin API routes expose settings, jobs and saved reports.
  const statistics=createStatistics(db,admin,options.statistics); // Scoped device reads reuse the same saved-record aggregation as admin reports.
  return {
    friends, statistics, aiAnalysis, notifications, economy, admin, ensureParticipant, createSession:sessions.create, session:sessions.read, sessionNow:sessions.now, saveLogin, takeLogin, records, sync, exportRows, growthChart, saveGrowthChart, migrateIssuer,
    deleteSession:sessions.remove,
    exportCharts: () => db.prepare('SELECT participant_id, payload_json, version, updated_at FROM growth_charts ORDER BY participant_id').all().map(row => ({ participantId: row.participant_id, chart: JSON.parse(row.payload_json), version: row.version, updatedAt: row.updated_at })), // Private administrator export, separate from observation CSV.
    list: () => db.prepare('SELECT id, label, created_at FROM participants ORDER BY created_at').all(),
    backup: destination => backup(db, destination), // Uses SQLite's online backup API so WAL data is included consistently.
    close: () => { economy.close(); db.close(); },
  };
}
