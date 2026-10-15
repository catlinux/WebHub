import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Devuelve «scrypt$N$r$p$sal$hash» (sal y hash en base64). */
export async function hashSecret(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifySecret(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** El PIN son solo dígitos: de 6 a 12. Con 6 cifras hay un millón de combinaciones; el bloqueo escalonado de
 * LoginLimiter hace inviable probarlas por la web. */
export const PIN_MIN = 6;
export const PIN_MAX = 12;
export const PIN_PATTERN = new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`);

export function getPinHash(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export async function setPin(db: DatabaseSync, pin: string): Promise<void> {
  if (!PIN_PATTERN.test(pin)) throw new Error(`El PIN debe tener de ${PIN_MIN} a ${PIN_MAX} dígitos (solo números).`);
  const hash = await hashSecret(pin);
  db.prepare("INSERT INTO settings (key, value) VALUES ('pin_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(hash);
  // Cambiar el PIN cierra todas las sesiones.
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
 * Límite de intentos de login fallidos, pensado para un PIN numérico:
 * - por IP: como mucho `maxPerIp` fallos en la ventana deslizante;
 * - global (todas las IP juntas): cada `streakLimit` fallos seguidos sin un acierto bloquean el login
 *   para todos durante `baseLockMs`, y cada nuevo bloqueo dura el doble, hasta `maxLockMs`.
 * Con los valores por defecto, tras un día de ataque solo se admiten unos 10 intentos cada 24 h.
 * El estado está en memoria: reiniciar el servicio lo borra (así el dueño puede desbloquearse).
 */
export class LoginLimiter {
  private readonly perIp = new Map<string, number[]>();
  private streak = 0;
  private lockedUntil = 0;
  private readonly maxPerIp: number;
  private readonly windowMs: number;
  private readonly streakLimit: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly clock: () => number;

  constructor(
    opts: { maxPerIp?: number; windowMs?: number; streakLimit?: number; baseLockMs?: number; maxLockMs?: number; clock?: () => number } = {},
  ) {
    this.maxPerIp = opts.maxPerIp ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.streakLimit = opts.streakLimit ?? 10;
    this.baseLockMs = opts.baseLockMs ?? 15 * 60_000;
    this.maxLockMs = opts.maxLockMs ?? 24 * 3600_000;
    this.clock = opts.clock ?? Date.now;
  }

  private recent(list: number[]): number[] {
    const since = this.clock() - this.windowMs;
    return list.filter((t) => t > since);
  }

  /** Segundos que faltan para poder intentarlo de nuevo; 0 si está permitido. */
  retryAfter(ip: string): number {
    const now = this.clock();
    let until = this.lockedUntil;
    const mine = this.recent(this.perIp.get(ip) ?? []);
    if (mine.length >= this.maxPerIp) until = Math.max(until, (mine[mine.length - this.maxPerIp] as number) + this.windowMs);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  /** Registra un fallo. Devuelve los ms de bloqueo global si este fallo lo ha activado. */
  fail(ip: string): number {
    const now = this.clock();
    const mine = this.recent(this.perIp.get(ip) ?? []);
    mine.push(now);
    this.perIp.set(ip, mine);
    if (this.perIp.size > 10_000) this.perIp.clear();
    this.streak++;
    if (this.streak % this.streakLimit !== 0) return 0;
    const round = this.streak / this.streakLimit;
    const lock = Math.min(this.baseLockMs * 2 ** (round - 1), this.maxLockMs);
    this.lockedUntil = now + lock;
    return lock;
  }

  succeed(ip: string): void {
    this.perIp.delete(ip);
    this.streak = 0;
    this.lockedUntil = 0;
  }
}
