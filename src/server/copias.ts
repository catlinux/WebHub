import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite';
import {
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  statSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TipoCopia = 'diaria' | 'manual' | 'antes-de-restaurar';

export interface InfoCopia {
  archivo: string;
  tipo: TipoCopia;
  fecha: string;
  bytes: number;
}

const TABLAS_CONTEO = ['families', 'links', 'sessions', 'passkeys', 'access_log', 'settings'] as const;

function nombreArchivo(tipo: TipoCopia, ahora: number): string {
  const iso = new Date(ahora).toISOString();
  const fecha = iso.slice(0, 10);
  const hora = iso.slice(11, 19).replace(/:/g, '');
  if (tipo === 'diaria') return `webhub-${fecha}.sqlite`;
  if (tipo === 'manual') return `webhub-manual-${fecha}_${hora}.sqlite`;
  return `webhub-antes-de-restaurar-${fecha}_${hora}.sqlite`;
}

function ponerSetting(db: DatabaseSync, clave: string, valor: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(clave, valor);
}

function borrarSetting(db: DatabaseSync, clave: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(clave);
}

function contar(db: DatabaseSync, tabla: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get() as { n: number };
  return row.n;
}

function contarTodas(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLAS_CONTEO) out[t] = contar(db, t);
  return out;
}
function limpiarTemporales(rutas: string[]): void {
  for (const r of rutas) {
    try {
      if (existsSync(r)) unlinkSync(r);
    } catch {
      // ignore
    }
  }
}

export function hacerCopia(db: DatabaseSync, dir: string, tipo: TipoCopia, ahora: number = Date.now()): InfoCopia {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed) {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }

  const fecha = new Date(ahora).toISOString();
  const finalName = nombreArchivo(tipo, ahora);
  const finalPath = join(dir, finalName);
  const tempPath = join(dir, `.tmp-${randomUUID()}.sqlite`);
  const temporales: string[] = [tempPath];

  try {
    const originVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const originCounts = contarTodas(db);

    const esc = tempPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${esc}'`);

    const checkDb = new DatabaseSyncCtor(tempPath, { readOnly: true });
    try {
      const ic = checkDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
      if (!ic || ic.integrity_check !== 'ok') {
        throw new Error('integrity_check no es ok');
      }
      const copyVersion = (checkDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (copyVersion !== originVersion) {
        throw new Error('user_version no coincide');
      }
      const copyCounts = contarTodas(checkDb);
      for (const t of TABLAS_CONTEO) {
        if (copyCounts[t] !== originCounts[t]) {
          throw new Error(`el número de filas de ${t} no coincide`);
        }
      }
    } finally {
      checkDb.close();
    }

    chmodSync(tempPath, 0o600);
    renameSync(tempPath, finalPath);

    if (tipo === 'diaria' || tipo === 'manual') {
      const stable = join(dir, 'webhub-ultima.sqlite');
      const stableTemp = join(dir, `.tmp-${randomUUID()}.sqlite`);
      temporales.push(stableTemp);
      try {
        copyFileSync(finalPath, stableTemp);
        chmodSync(stableTemp, 0o600);
        renameSync(stableTemp, stable);
      } catch (err) {
        throw err;
      }
    }

    if (tipo === 'diaria' || tipo === 'manual') {
      ponerSetting(db, 'copia_ultima_ok', fecha);
    }
    borrarSetting(db, 'copia_ultimo_error');

    const bytes = statSync(finalPath).size;
    return { archivo: finalName, tipo, fecha, bytes };
  } catch (err) {
    limpiarTemporales(temporales);
    // best effort: if a temp remains registered, attempt again
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`No se pudo crear la copia: ${msg}`);
  }
}

export function purgarCopias(dir: string, conservar: number = 14): string[] {
  if (!Number.isInteger(conservar) || conservar < 1) conservar = 14;
  if (!existsSync(dir)) return [];
  let entries: { name: string; isFile: boolean }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() }));
  } catch {
    return [];
  }

  function fechaValidaDiaria(n: string): string | null {
    const m = /^webhub-(\d{4})-(\d{2})-(\d{2})\.sqlite$/.exec(n);
    if (!m) return null;
    const [, y, mo, d] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (dt.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
    return `${y}-${mo}-${d}`;
  }

  function parseManualAntes(prefix: string, n: string): string | null {
    const re = new RegExp(`^webhub-${prefix}-(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})(\\d{2})(\\d{2})\\.sqlite$`);
    const m = re.exec(n);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    const expected = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
    if (dt.toISOString() !== expected) return null;
    return expected;
  }

  const diarias: { name: string; clave: string }[] = [];
  const manuales: { name: string; clave: string }[] = [];
  const anteriores: { name: string; clave: string }[] = [];

  for (const e of entries) {
    if (!e.isFile) continue;
    if (e.name === 'webhub-ultima.sqlite') continue;
    const d = fechaValidaDiaria(e.name);
    if (d) { diarias.push({ name: e.name, clave: d }); continue; }
    const man = parseManualAntes('manual', e.name);
    if (man) { manuales.push({ name: e.name, clave: man }); continue; }
    const ant = parseManualAntes('antes-de-restaurar', e.name);
    if (ant) { anteriores.push({ name: e.name, clave: ant }); continue; }
  }

  const borrar: string[] = [];
  // sort descending by clave (most recent first)
  diarias.sort((a, b) => (a.clave < b.clave ? 1 : a.clave > b.clave ? -1 : 0));
  manuales.sort((a, b) => (a.clave < b.clave ? 1 : a.clave > b.clave ? -1 : 0));
  anteriores.sort((a, b) => (a.clave < b.clave ? 1 : a.clave > b.clave ? -1 : 0));

  const keepDiarias = Math.max(0, conservar);
  for (let i = keepDiarias; i < diarias.length; i++) borrar.push(diarias[i].name);
  for (let i = 10; i < manuales.length; i++) borrar.push(manuales[i].name);
  for (let i = 5; i < anteriores.length; i++) borrar.push(anteriores[i].name);

  const borrados: string[] = [];
  for (const n of borrar) {
    try {
      unlinkSync(join(dir, n));
      borrados.push(n);
    } catch {
      // ignore
    }
  }
  borrados.sort();
  return borrados;
}

export function listarCopias(dir: string): InfoCopia[] {
  if (!existsSync(dir)) return [];
  let entries: { name: string; isFile: boolean }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isFile: e.isFile() }));
  } catch {
    return [];
  }

  function fechaValidaDiaria(n: string): string | null {
    const m = /^webhub-(\d{4})-(\d{2})-(\d{2})\.sqlite$/.exec(n);
    if (!m) return null;
    const [, y, mo, d] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    if (dt.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
    return `${y}-${mo}-${d}T00:00:00.000Z`;
  }

  function parseManualAntes(prefix: string, n: string, label: string): { fecha: string } | null {
    const re = new RegExp(`^webhub-${prefix}-(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})(\\d{2})(\\d{2})\\.sqlite$`);
    const m = re.exec(n);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    const expected = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
    if (dt.toISOString() !== expected) return null;
    return { fecha: expected };
  }

  const result: InfoCopia[] = [];
  for (const e of entries) {
    if (!e.isFile) continue;
    if (e.name === 'webhub-ultima.sqlite') continue;
    const d = fechaValidaDiaria(e.name);
    if (d) {
      try {
        const st = statSync(join(dir, e.name));
        result.push({ archivo: e.name, tipo: 'diaria', fecha: d, bytes: st.size });
      } catch { /* ignore */ }
      continue;
    }
    const man = parseManualAntes('manual', e.name, 'manual');
    if (man) {
      try {
        const st = statSync(join(dir, e.name));
        result.push({ archivo: e.name, tipo: 'manual', fecha: man.fecha, bytes: st.size });
      } catch { /* ignore */ }
      continue;
    }
    const ant = parseManualAntes('antes-de-restaurar', e.name, 'antes');
    if (ant) {
      try {
        const st = statSync(join(dir, e.name));
        result.push({ archivo: e.name, tipo: 'antes-de-restaurar', fecha: ant.fecha, bytes: st.size });
      } catch { /* ignore */ }
      continue;
    }
  }
  result.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
  return result;
}

export function estadoCopias(
  db: DatabaseSync,
  dir: string,
  ahora: number = Date.now(),
): { carpeta: string; ultimaOk: string | null; ultimoError: string | null; total: number; horasDesdeUltima: number | null; aviso: boolean; archivoEstable: InfoCopia | null } {
  const ultimaOk = leerSetting(db, 'copia_ultima_ok');
  const ultimoError = leerSetting(db, 'copia_ultimo_error');
  let horasDesdeUltima: number | null = null;
  if (ultimaOk) {
    const t = Date.parse(ultimaOk);
    if (!Number.isNaN(t)) horasDesdeUltima = (ahora - t) / 3600000;
  }
  const total = listarCopias(dir).length;
  let archivoEstable: InfoCopia | null = null;
  const stablePath = join(dir, 'webhub-ultima.sqlite');
  if (existsSync(stablePath)) {
    try {
      const st = statSync(stablePath);
      archivoEstable = { archivo: 'webhub-ultima.sqlite', tipo: 'diaria', fecha: st.mtime.toISOString(), bytes: st.size };
    } catch { /* ignore */ }
  }
  const aviso = ultimaOk === null || horasDesdeUltima === null || horasDesdeUltima > 36 || total === 0;
  return { carpeta: dir, ultimaOk, ultimoError, total, horasDesdeUltima, aviso, archivoEstable };
}

function leerSetting(db: DatabaseSync, clave: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(clave) as { value: string } | undefined;
  return row ? row.value : null;
}

export class ProgramadorCopias {
  private db: DatabaseSync;
  private dir: string;
  private conservar: number;
  private cadaMs: number;
  private primerAvisoMs: number;
  private reloj: () => number;
  private timerPrimero: ReturnType<typeof setTimeout> | null = null;
  private timerIntervalo: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: DatabaseSync,
    dir: string,
    opciones: { conservar?: number; cadaMs?: number; primerAvisoMs?: number; reloj?: () => number } = {},
  ) {
    this.db = db;
    this.dir = dir;
    this.conservar = (typeof opciones.conservar === 'number' && Number.isInteger(opciones.conservar) && opciones.conservar >= 1)
      ? opciones.conservar : 14;
    this.cadaMs = opciones.cadaMs ?? 1_800_000;
    this.primerAvisoMs = opciones.primerAvisoMs ?? 60_000;
    this.reloj = opciones.reloj ?? (() => Date.now());
  }

  revisar(): InfoCopia | null {
    const ahora = this.reloj();
    try {
      const diarias = listarCopias(this.dir).filter((c) => c.tipo === 'diaria');
      let need = diarias.length === 0;
      if (!need) {
        let mtimeMax = 0;
        for (const c of diarias) {
          try {
            const st = statSync(join(this.dir, c.archivo));
            if (st.mtimeMs > mtimeMax) mtimeMax = st.mtimeMs;
          } catch { /* ignore */ }
        }
        if (mtimeMax === 0 || ahora - mtimeMax > 24 * 60 * 60 * 1000) need = true;
      }
      if (!need) return null;
      const copia = hacerCopia(this.db, this.dir, 'diaria', ahora);
      purgarCopias(this.dir, this.conservar);
      return copia;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        ponerSetting(this.db, 'copia_ultimo_error', `${new Date(ahora).toISOString()} ${msg}`);
      } catch {
        /* la base no responde: no se puede anotar el error, pero tampoco debe propagarse */
      }
      console.error('Error al hacer la copia automática de la base de datos.');
      return null;
    }
  }

  iniciar(): void {
    if (this.timerPrimero || this.timerIntervalo) return;
    this.timerPrimero = setTimeout(() => {
      try { this.revisar(); } catch { /* never throws */ }
      if (this.timerIntervalo === null) {
        this.timerIntervalo = setInterval(() => {
          try { this.revisar(); } catch { /* never throws */ }
        }, this.cadaMs);
        if (this.timerIntervalo && typeof (this.timerIntervalo as any).unref === 'function') (this.timerIntervalo as any).unref();
      }
    }, this.primerAvisoMs);
    if (this.timerPrimero && typeof (this.timerPrimero as any).unref === 'function') (this.timerPrimero as any).unref();
  }

  detener(): void {
    if (this.timerPrimero) {
      clearTimeout(this.timerPrimero);
      this.timerPrimero = null;
    }
    if (this.timerIntervalo) {
      clearInterval(this.timerIntervalo);
      this.timerIntervalo = null;
    }
  }
}