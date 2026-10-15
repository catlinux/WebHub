import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE families (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES families(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    last_click_at TEXT,
    check_status TEXT,
    checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX links_family ON links(family_id, position);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE favicons (
    host TEXT PRIMARY KEY,
    mime TEXT,
    data BLOB,
    fetched_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    alg INTEGER NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  `,
  `ALTER TABLE families ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0;`,
  `
  CREATE TABLE access_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX access_log_at ON access_log(at);
  `,
  `ALTER TABLE links ADD COLUMN check_ignored INTEGER NOT NULL DEFAULT 0;`,
];

/** Abre (o crea) la base de datos y aplica las migraciones pendientes. */
export function openDatabase(dataDir: string | null): DatabaseSync {
  let path = ':memory:';
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    path = join(dataDir, 'webhub.sqlite');
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i] as string);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

/** Ejecuta `fn` dentro de una transacción. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
