import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Devuelve «scrypt$N$r$p$sal$hash» (sal y hash en base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const MIN_PASSWORD_LENGTH = 12;

export function getPasswordHash(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setPassword(db: DatabaseSync, password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  const hash = await hashPassword(password);
  db.prepare("INSERT INTO settings (key, value) VALUES ('password_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  // Cambiar la contraseña cierra todas las sesiones.
  db.prepare('DELETE FROM sessions').run();
}

const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

/** Crea una sesión y devuelve el token en claro (solo viaja en la cookie; en la BD se guarda su hash). */
export function createSession(db: DatabaseSync, days: number, now = Date.now()): { token: string; expires: Date } {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now + days * 86_400_000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    new Date(now).toISOString(),
    expires.toISOString(),
  );
  return { token, expires };
}

export function isValidSession(db: DatabaseSync, token: string | undefined, now = Date.now()): boolean {
  if (!token || token.length > 100) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | { expires_at: string }
    | undefined;
  return !!row && Date.parse(row.expires_at) > now;
}

export function deleteSession(db: DatabaseSync, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/**
 * Límite de intentos de login fallidos: por IP y global (para frenar
 * también ataques repartidos entre muchas IP). Ventana deslizante en memoria.
 */
export class LoginLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];

  private readonly maxPerIp: number;
  private readonly maxGlobal: number;
  private readonly windowMs: number;
  private readonly clock: () => number;

  constructor(maxPerIp = 5, maxGlobal = 30, windowMs = 15 * 60_000, clock: () => number = Date.now) {
    this.maxPerIp = maxPerIp;
    this.maxGlobal = maxGlobal;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  private recent(list: number[]): number[] {
    const since = this.clock() - this.windowMs;
    return list.filter((t) => t > since);
  }

  /** Segundos que faltan para poder intentarlo de nuevo; 0 si está permitido. */
  retryAfter(ip: string): number {
    const mine = this.recent(this.perIp.get(ip) ?? []);
    this.global = this.recent(this.global);
    const blockers: number[] = [];
    if (mine.length >= this.maxPerIp) blockers.push(mine[mine.length - this.maxPerIp] as number);
    if (this.global.length >= this.maxGlobal) blockers.push(this.global[this.global.length - this.maxGlobal] as number);
    if (blockers.length === 0) return 0;
    const until = Math.max(...blockers) + this.windowMs;
    return Math.max(1, Math.ceil((until - this.clock()) / 1000));
  }

  fail(ip: string): void {
    const now = this.clock();
    const mine = this.recent(this.perIp.get(ip) ?? []);
    mine.push(now);
    this.perIp.set(ip, mine);
    this.global.push(now);
    if (this.perIp.size > 10_000) this.perIp.clear();
  }

  succeed(ip: string): void {
    this.perIp.delete(ip);
  }
}
