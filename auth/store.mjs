import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const derive = promisify(scrypt);
export const authDirectory = () => resolve(process.env.AUTH_DATA_DIR ?? 'data/auth');

async function passwordHash(password, salt) { // Uses a memory-hard password KDF; passwords never enter SQLite or application logs.
  return Buffer.from(await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
}

export function openAuthStore(directory = authDirectory()) { // Keeps the shared identity database independent from every application's data schema.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(directory, 'auth.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oidc (model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER, uid TEXT, grant_id TEXT, user_code TEXT, PRIMARY KEY(model,id));
    CREATE INDEX IF NOT EXISTS oidc_uid ON oidc(model,uid);
    CREATE INDEX IF NOT EXISTS oidc_grant ON oidc(grant_id);
    CREATE TABLE IF NOT EXISTS throttle (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  const now = () => Math.floor(Date.now() / 1000);

  function rateLimit(key, maximum = 10) { // Persists login throttling across restarts and counts attempts before expensive password verification.
    db.prepare('DELETE FROM throttle WHERE expires <= ?').run(now());
    const row = db.prepare(`INSERT INTO throttle VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).get(key, now() + 900);
    return row.attempts <= maximum;
  }

  async function setPassword(username, password, create = false) { // Creates an account or resets its password while keeping the stable OIDC subject unchanged.
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) throw new Error('Usernames must use 3–40 lowercase letters, numbers, dots, underscores, or hyphens.');
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Passwords must have 12–128 characters.');
    const salt = randomBytes(32).toString('base64url');
    const digest = (await passwordHash(password, salt)).toString('base64url');
    if (create) db.prepare('INSERT INTO accounts (id,username,salt,hash,created_at) VALUES (?,?,?,?,?)').run(randomUUID(), username, salt, digest, new Date().toISOString());
    else {
      const account = db.prepare('SELECT id FROM accounts WHERE username=?').get(username);
      if (!account) throw new Error('Account not found.');
      db.prepare('UPDATE accounts SET salt=?,hash=? WHERE id=?').run(salt, digest, account.id);
      db.prepare("DELETE FROM oidc WHERE json_extract(payload,'$.accountId')=?").run(account.id); // Invalidates shared sessions and tokens after a password reset.
    }
  }

  async function verify(username, password) { // Performs the same KDF for unknown usernames to reduce account-enumeration timing differences.
    const row = db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const actual = await passwordHash(password, row?.salt ?? 'unknown-account-timing-salt');
    const expected = row ? Buffer.from(row.hash, 'base64url') : Buffer.alloc(64);
    return timingSafeEqual(actual, expected) && row && !row.disabled ? { id: row.id, username: row.username } : null;
  }

  class Adapter { // Implements oidc-provider's persistent adapter contract for sessions, grants, codes, and tokens.
    constructor(model) { this.model = model; }
    async upsert(id, payload, expiresIn) {
      db.prepare(`INSERT INTO oidc VALUES (?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires,uid=excluded.uid,grant_id=excluded.grant_id,user_code=excluded.user_code`)
        .run(this.model, id, JSON.stringify(payload), expiresIn ? now() + expiresIn : null, payload.uid ?? null, payload.grantId ?? null, payload.userCode ?? null);
    }
    read(column, value) { // Uses only internally selected column names; all external values remain bound parameters.
      const row = db.prepare(`SELECT payload FROM oidc WHERE model=? AND ${column}=? AND (expires IS NULL OR expires>?)`).get(this.model, value, now());
      return row ? JSON.parse(row.payload) : undefined;
    }
    async find(id) { return this.read('id', id); }
    async findByUid(uid) { return this.read('uid', uid); }
    async findByUserCode(code) { return this.read('user_code', code); }
    async consume(id) { db.prepare("UPDATE oidc SET payload=json_set(payload,'$.consumed',?) WHERE model=? AND id=?").run(now(), this.model, id); }
    async destroy(id) { db.prepare('DELETE FROM oidc WHERE model=? AND id=?').run(this.model, id); }
    async revokeByGrantId(id) { db.prepare('DELETE FROM oidc WHERE grant_id=?').run(id); }
  }

  return {
    Adapter, rateLimit, setPassword, verify,
    account: id => db.prepare('SELECT id,username FROM accounts WHERE id=? AND disabled=0').get(id),
    list: () => db.prepare('SELECT id,username,disabled,created_at FROM accounts ORDER BY created_at').all(),
    disable(username) { // Prevents new authentication and removes shared sessions without deleting identity or app records.
      const row = db.prepare('UPDATE accounts SET disabled=1 WHERE username=? RETURNING id').get(username);
      if (!row) throw new Error('Account not found.');
      db.prepare("DELETE FROM oidc WHERE json_extract(payload,'$.accountId')=?").run(row.id);
    },
    cleanup: () => db.prepare('DELETE FROM oidc WHERE expires IS NOT NULL AND expires<=?').run(now()),
    backup: path => backup(db, path),
    close: () => db.close(),
  };
}
