import type { DatabaseSync } from 'node:sqlite';

export interface AccessEntry {
  id: number;
  at: string;
  kind: string;
  ok: number;
  ip: string;
  device: string;
  detail: string;
}

export type Entry = AccessEntry;

interface AccessRow {
  id: number;
  at: string;
  kind: string;
  ok: number;
  ip: string;
  device: string;
  detail: string;
}

interface SettingRow {
  value: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 180;
const MAX_ENTRIES = 1000;
const PROTECTED_SUCCESSES = 100;

export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  let browser = 'Navegador';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/') || ua.includes('CriOS/')) browser = 'Chrome';
  else if (ua.includes('Firefox/') || ua.includes('FxiOS/')) browser = 'Firefox';
  else if (ua.includes('Safari/')) browser = 'Safari';

  let os = 'sistema desconocido';
  if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone')) os = 'iPhone';
  else if (ua.includes('iPad')) os = 'iPad';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac')) os = 'Mac';
  else if (ua.includes('Linux')) os = 'Linux';

  if (browser === 'Navegador' && os === 'sistema desconocido') {
    return 'Navegador desconocido';
  }
  return `${browser} en ${os}`;
}

export function logAccess(
  db: DatabaseSync,
  entry: { kind: string; ok: boolean; ip: string; userAgent?: string; detail?: string },
  now: number = Date.now(),
): void {
  try {
    const kind = entry.kind;
    const protectedKind = kind === 'bloqueo' || kind === 'huella-alta' || kind === 'huella-baja' || kind === 'pin-desactivado' || kind === 'pin-activado';
    const discardableFailure = !entry.ok && !protectedKind;

    if (discardableFailure) {
      const cutoff = new Date(now - ONE_HOUR_MS).toISOString();
      const row = db.prepare('SELECT COUNT(*) AS n FROM access_log WHERE ok = 0 AND at >= ?').get(cutoff) as { n: number };
      if (row.n >= 30) {
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('access_omitted', '1') " +
            "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
        ).run();
        return;
      }
    }

    const at = new Date(now).toISOString();
    const ip = (entry.ip ?? '').slice(0, 64);
    const detail = (entry.detail ?? '').slice(0, 120);
    const device = deviceLabel(entry.userAgent);

    db.prepare(
      'INSERT INTO access_log (at, kind, ok, ip, device, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(at, kind, entry.ok ? 1 : 0, ip, device, detail);

    purge(db, now);
  } catch (err) {
    console.error('Error al registrar acceso.');
  }
}

function purge(db: DatabaseSync, now: number): void {
  const oldCutoff = new Date(now - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM access_log WHERE at < ?').run(oldCutoff);

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM access_log').get() as { n: number };
  if (totalRow.n <= MAX_ENTRIES) return;

  const excess = totalRow.n - MAX_ENTRIES;
  const protectedRows = db.prepare(
    'SELECT id FROM access_log WHERE ok = 1 ORDER BY at DESC, id DESC LIMIT ?',
  ).all(PROTECTED_SUCCESSES) as unknown as { id: number }[];
  const protectedIds = new Set(protectedRows.map((r) => r.id));

  const rows = db.prepare('SELECT id FROM access_log ORDER BY at ASC, id ASC').all() as unknown as { id: number }[];
  const toDelete: number[] = [];
  for (const r of rows) {
    if (toDelete.length >= excess) break;
    if (protectedIds.has(r.id)) continue;
    toDelete.push(r.id);
  }
  const stmt = db.prepare('DELETE FROM access_log WHERE id = ?');
  for (const id of toDelete) stmt.run(id);
}

export function listAccess(db: DatabaseSync, limit: unknown): AccessEntry[] {
  const n = clampLimit(limit);
  const rows = db
    .prepare('SELECT id, at, kind, ok, ip, device, detail FROM access_log ORDER BY at DESC, id DESC LIMIT ?')
    .all(n) as unknown as AccessRow[];
  return rows.map((r) => ({ ...r, ok: r.ok }));
}

function clampLimit(limit: unknown): number {
  let n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n)) n = 50;
  n = Math.trunc(n);
  if (n < 1) n = 1;
  if (n > 200) n = 200;
  return n;
}

export function accessSummary(db: DatabaseSync): { fallos: number; desde: string | null } {
  const current = db
    .prepare(
      "SELECT id, at FROM access_log WHERE ok = 1 AND kind IN ('pin', 'huella') ORDER BY at DESC, id DESC LIMIT 1",
    )
    .get() as { id: number; at: string } | undefined;

  if (!current) return { fallos: 0, desde: null };

  const previous = db
    .prepare(
      "SELECT id, at FROM access_log WHERE ok = 1 AND kind IN ('pin', 'huella') AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT 1",
    )
    .get(current.at, current.at, current.id) as { id: number; at: string } | undefined;

  if (!previous) {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM access_log WHERE ok = 0 AND kind IN ('pin', 'huella') AND (at < ? OR (at = ? AND id < ?))",
      )
      .get(current.at, current.at, current.id) as { n: number };
    return { fallos: row.n, desde: null };
  }

  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM access_log WHERE ok = 0 AND kind IN ('pin', 'huella') " +
        "AND (at > ? OR (at = ? AND id > ?)) AND (at < ? OR (at = ? AND id < ?))",
    )
    .get(previous.at, previous.at, previous.id, current.at, current.at, current.id) as { n: number };

  return { fallos: row.n, desde: previous.at };
}

export function omittedCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'access_omitted'").get() as SettingRow | undefined;
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}
