import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { b64urlEncode } from './webauthn.ts';

interface PasskeyRow {
  id: string;
  public_key: string;
  alg: number;
  counter: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface Passkey {
  id: string;
  publicKey: string;
  alg: number;
  counter: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function toPasskey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    publicKey: row.public_key,
    alg: row.alg,
    counter: row.counter,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

const nowIso = () => new Date().toISOString();

export function listPasskeys(db: DatabaseSync): Passkey[] {
  const rows = db.prepare('SELECT * FROM passkeys ORDER BY created_at, id').all() as unknown as PasskeyRow[];
  return rows.map(toPasskey);
}

export function getPasskey(db: DatabaseSync, id: string): Passkey | null {
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id) as unknown as PasskeyRow | undefined;
  return row ? toPasskey(row) : null;
}

export function countPasskeys(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number };
  return row.n;
}

export function insertPasskey(
  db: DatabaseSync,
  input: { id: string; publicKey: string; alg: number; counter: number; name: string },
): Passkey {
  const createdAt = nowIso();
  db.prepare('INSERT INTO passkeys (id, public_key, alg, counter, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
    .run(input.id, input.publicKey, input.alg, input.counter, input.name, createdAt);
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(input.id) as unknown as PasskeyRow;
  return toPasskey(row);
}

export function updatePasskeyUsage(db: DatabaseSync, id: string, counter: number): void {
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, nowIso(), id);
}

export function deletePasskey(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
}

export function getWebAuthnUserId(db: DatabaseSync): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'webauthn_user_id'").get() as { value: string } | undefined;
  if (row) return row.value;
  const value = b64urlEncode(randomBytes(32));
  db.prepare("INSERT INTO settings (key, value) VALUES ('webauthn_user_id', ?) ON CONFLICT(key) DO NOTHING").run(value);
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'webauthn_user_id'").get() as { value: string };
  return saved.value;
}