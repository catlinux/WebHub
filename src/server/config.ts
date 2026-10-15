import { resolve } from 'node:path';

const env = process.env;

/** Configuración por variables de entorno (ver docs/despliegue.md). */
export const config = {
  port: Number(env.WEBHUB_PORT ?? 3000),
  host: env.WEBHUB_HOST ?? '127.0.0.1',
  dataDir: resolve(env.WEBHUB_DATA_DIR ?? 'data'),
  /** Solo para desarrollo local por http: la cookie de sesión deja de ser Secure. */
  insecureCookie: env.WEBHUB_INSECURE_COOKIE === '1',
  /** Detrás de Caddy: se toma la IP del cliente de X-Forwarded-For. */
  trustProxy: env.WEBHUB_TRUST_PROXY === '1',
  /** Origen público, p. ej. https://webhub.ejemplo.com. Si falta se compara con Host. */
  publicOrigin: env.WEBHUB_PUBLIC_ORIGIN ?? '',
  sessionDays: Number(env.WEBHUB_SESSION_DAYS ?? 30),
};
