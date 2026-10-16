import { resolve, join } from 'node:path';

const env = process.env;

const dataDir = resolve(env.WEBHUB_DATA_DIR ?? 'data');

/** Configuración por variables de entorno (ver docs/despliegue.md). */
export const config = {
  port: Number(env.WEBHUB_PORT ?? 3000),
  host: env.WEBHUB_HOST ?? '127.0.0.1',
  dataDir,
  /** Carpeta fija de las copias automáticas. */
  backupDir: resolve(env.WEBHUB_BACKUP_DIR ?? join(dataDir, 'copias')),
  /** Número de copias diarias a conservar. */
  backupKeep: (() => {
    const n = Number(env.WEBHUB_BACKUP_KEEP ?? 14);
    return Number.isInteger(n) && n >= 1 ? n : 14;
  })(),
  /** Activa la copia automática diaria. */
  backupEnabled: env.WEBHUB_BACKUP !== '0',
  /** Espera antes de la primera revisión de copias tras arrancar (ms). Solo para diagnóstico y pruebas. */
  backupFirstDelayMs: (() => {
    const n = Number(env.WEBHUB_BACKUP_FIRST_DELAY_MS ?? 60_000);
    return Number.isInteger(n) && n >= 0 ? n : 60_000;
  })(),
  /** Solo para desarrollo local por http: la cookie de sesión deja de ser Secure. */
  insecureCookie: env.WEBHUB_INSECURE_COOKIE === '1',
  /** Detrás de Caddy: se toma la IP del cliente de X-Forwarded-For. */
  trustProxy: env.WEBHUB_TRUST_PROXY === '1',
  /** Origen público, p. ej. https://webhub.ejemplo.com. Si falta se compara con Host. */
  publicOrigin: env.WEBHUB_PUBLIC_ORIGIN ?? '',
  sessionDays: Number(env.WEBHUB_SESSION_DAYS ?? 30),
};
