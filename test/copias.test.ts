import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/server/db.ts';
import { Repo } from '../src/server/repo.ts';
import {
  hacerCopia, purgarCopias, listarCopias, estadoCopias, ProgramadorCopias,
} from '../src/server/copias.ts';
function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'wh-')); }

function mkDbWithData() {
  const db = openDatabase(null);
  const repo = new Repo(db);
  const fam = repo.createFamily({ name: 'Fam' });
  repo.createLink({ familyId: fam.id, url: 'https://example.com/a', title: 'A' });
  db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?,?,?)").run('t', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  db.prepare("INSERT INTO passkeys (id, public_key, alg, counter, name, created_at) VALUES (?,?,?,?,?,?)").run('pk1', 'pub', 7, 0, 'huella', '2026-01-01T00:00:00Z');
  db.prepare("INSERT INTO access_log (at, kind, ok) VALUES (?,?,?)").run('2026-01-01T00:00:00Z', 'pin', 1);
  db.prepare("INSERT INTO settings (key, value) VALUES (?,?)").run('tema', 'claro');
  return db;
}

function fileMode(p: string): number { return fs.statSync(p).mode & 0o777; }

test('copia diaria crea archivo con fecha UTC y mismos datos', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const ahora = Date.UTC(2026, 0, 15, 12, 34, 56);
  const info = hacerCopia(db, dir, 'diaria', ahora);
  const expected = 'webhub-2026-01-15.sqlite';
  assert.equal(info.archivo, expected);
  assert.equal(info.tipo, 'diaria');
  assert.equal(info.fecha, new Date(ahora).toISOString());
  assert.ok(info.bytes > 0);
  const copy = new DatabaseSync(path.join(dir, expected), { readOnly: true });
  try {
    const origFamilies = db.prepare('SELECT COUNT(*) n FROM families').get() as any;
    const copyFamilies = copy.prepare('SELECT COUNT(*) n FROM families').get() as any;
    assert.equal(copyFamilies.n, origFamilies.n);
    const origLinks = db.prepare('SELECT COUNT(*) n FROM links').get() as any;
    const copyLinks = copy.prepare('SELECT COUNT(*) n FROM links').get() as any;
    assert.equal(copyLinks.n, origLinks.n);
    const origSettings = db.prepare("SELECT value FROM settings WHERE key='tema'").get() as any;
    const copySettings = copy.prepare("SELECT value FROM settings WHERE key='tema'").get() as any;
    assert.equal(copySettings.value, origSettings.value);
    const origPasskeys = db.prepare('SELECT COUNT(*) n FROM passkeys').get() as any;
    const copyPasskeys = copy.prepare('SELECT COUNT(*) n FROM passkeys').get() as any;
    assert.equal(copyPasskeys.n, origPasskeys.n);
    const origLog = db.prepare('SELECT COUNT(*) n FROM access_log').get() as any;
    const copyLog = copy.prepare('SELECT COUNT(*) n FROM access_log').get() as any;
    assert.equal(copyLog.n, origLog.n);
    const ic = copy.prepare('PRAGMA integrity_check').get() as any;
    assert.equal(ic.integrity_check, 'ok');
  } finally { copy.close(); }
  // permisos
  assert.equal(fileMode(path.join(dir, expected)), 0o600);
  assert.equal(fileMode(dir), 0o700);
});

test('directorio se crea si no existe (anidado)', () => {
  const db = mkDbWithData();
  const base = tmpDir();
  const dir = path.join(base, 'a', 'b', 'c');
  hacerCopia(db, dir, 'diaria', Date.now());
  assert.ok(fs.existsSync(dir));
  assert.equal(fileMode(dir), 0o700);
});

test('dos copias diarias mismo dia dejan un solo archivo', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const ahora1 = Date.UTC(2026, 2, 10, 8, 0, 0);
  hacerCopia(db, dir, 'diaria', ahora1);
  // añadir un enlace para "contenido nuevo"
  const repo = new Repo(db);
  const fams = db.prepare('SELECT id FROM families LIMIT 1').get() as any;
  repo.createLink({ familyId: fams.id, url: 'https://example.com/b', title: 'B' });
  const ahora2 = Date.UTC(2026, 2, 10, 9, 0, 0);
  hacerCopia(db, dir, 'diaria', ahora2);
  const files = fs.readdirSync(dir).filter((f) => /^webhub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f));
  assert.equal(files.length, 1);
  assert.equal(files[0], 'webhub-2026-03-10.sqlite');
  const copy = new DatabaseSync(path.join(dir, files[0]), { readOnly: true });
  try {
    const n = (copy.prepare('SELECT COUNT(*) n FROM links').get() as any).n;
    assert.equal(n, 2);
  } finally { copy.close(); }
});

test('manual y antes tienen nombre propio y no se pisan', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const ahora1 = Date.UTC(2026, 3, 5, 10, 11, 12);
  const ahora2 = Date.UTC(2026, 3, 5, 10, 11, 13);
  const m = hacerCopia(db, dir, 'manual', ahora1);
  const a = hacerCopia(db, dir, 'antes-de-restaurar', ahora2);
  assert.match(m.archivo, /^webhub-manual-\d{4}-\d{2}-\d{2}_\d{6}\.sqlite$/);
  assert.match(a.archivo, /^webhub-antes-de-restaurar-\d{4}-\d{2}-\d{2}_\d{6}\.sqlite$/);
  assert.notEqual(m.archivo, a.archivo);
  assert.ok(fs.existsSync(path.join(dir, m.archivo)));
  assert.ok(fs.existsSync(path.join(dir, a.archivo)));
});

test('webhub-ultima.sqlite tras diaria y manual, no cambia con antes', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const hacer = (tipo: any, ahora: number) => hacerCopia(db, dir, tipo, ahora);
  hacer('diaria', Date.UTC(2026,4,1,1,0,0));
  const stable1 = fs.statSync(path.join(dir,'webhub-ultima.sqlite')).size;
  hacer('manual', Date.UTC(2026,4,1,2,0,0));
  const stable2 = fs.statSync(path.join(dir,'webhub-ultima.sqlite')).size;
  assert.ok(stable2 > 0);
  const hashBefore = fs.readFileSync(path.join(dir,'webhub-ultima.sqlite'));
  hacer('antes-de-restaurar', Date.UTC(2026,4,1,3,0,0));
  const hashAfter = fs.readFileSync(path.join(dir,'webhub-ultima.sqlite'));
  assert.deepEqual(hashAfter, hashBefore);
  assert.ok(fs.existsSync(path.join(dir,'webhub-ultima.sqlite')));
});

test('no quedan .tmp tras exito', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  hacerCopia(db, dir, 'diaria', Date.now());
  hacerCopia(db, dir, 'manual', Date.now()+1000);
  const tmps = fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-'));
  assert.equal(tmps.length, 0);
});

test('fallo por directorio de solo lectura lanza Error y no deja temporales', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  hacerCopia(db, dir, 'diaria', Date.now()); // good
  const stableBefore = fs.readFileSync(path.join(dir,'webhub-ultima.sqlite'));
  const ro = path.join(dir, 'ro');
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o555);
  // último estable sigue igual si falla
  let threw = false;
  try {
    hacerCopia(db, ro, 'diaria', Date.now());
  } catch (e) {
    threw = true;
    assert.ok(e instanceof Error);
  }
  fs.chmodSync(ro, 0o700);
  assert.ok(threw);
  const tmps = fs.readdirSync(ro).filter((f) => f.startsWith('.tmp-'));
  assert.equal(tmps.length, 0);
  const stableAfter = fs.readFileSync(path.join(dir,'webhub-ultima.sqlite'));
  assert.deepEqual(stableAfter, stableBefore);
});

test('fallo por verificacion (directorio invalido) lanza Error', () => {
  const db = mkDbWithData();
  const tmp = tmpDir();
  const bloqueante = path.join(tmp, 'archivo');
  fs.writeFileSync(bloqueante, 'x');
  const dir = path.join(bloqueante, 'sub');
  let threw = false;
  try {
    hacerCopia(db, dir, 'diaria', Date.now());
  } catch (e) {
    threw = true;
    assert.ok(e instanceof Error);
  }
  assert.ok(threw);
});

test('ruta con comilla simple funciona', () => {
  const db = mkDbWithData();
  const base = tmpDir();
  const dir = path.join(base, "dir'quote");
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o700);
  const info = hacerCopia(db, dir, 'diaria', Date.now());
  assert.ok(fs.existsSync(path.join(dir, info.archivo)));
});

test('permisos con umask 0', () => {
  const prev = process.umask(0);
  try {
    const db = mkDbWithData();
    const dir = path.join(tmpDir(), 'nested' + "'q");
    const info = hacerCopia(db, dir, 'manual', Date.now());
    assert.equal(fileMode(dir), 0o700);
    assert.equal(fileMode(path.join(dir, info.archivo)), 0o600);
    assert.equal(fileMode(path.join(dir, 'webhub-ultima.sqlite')), 0o600);
  } finally {
    process.umask(prev);
  }
});

test('purgarCopias conserva N diarias mas recientes', () => {
  const dir = tmpDir();
  const fechas = [
    Date.UTC(2026,0,1), Date.UTC(2026,0,2), Date.UTC(2026,0,3),
    Date.UTC(2026,0,4), Date.UTC(2026,0,5),
  ];
  for (const f of fechas) {
    const db = mkDbWithData();
    hacerCopia(db, dir, 'diaria', f);
  }
  const borrados = purgarCopias(dir, 2);
  const restantes = fs.readdirSync(dir).filter((f)=>/^webhub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)).sort();
  assert.equal(restantes.length, 2);
  assert.deepEqual(restantes, ['webhub-2026-01-04.sqlite','webhub-2026-01-05.sqlite']);
  assert.equal(borrados.length, 3);
});

test('purgarCopias conserva 10 manuales y 5 previas', () => {
  const dir = tmpDir();
  // 12 manuales distintos
  let t = Date.UTC(2026,1,1,0,0,0);
  for (let i=0;i<12;i++){ const db=mkDbWithData(); hacerCopia(db,dir,'manual',t); t+=1000; }
  // 6 previas
  t = Date.UTC(2026,2,1,0,0,0);
  for (let i=0;i<6;i++){ const db=mkDbWithData(); hacerCopia(db,dir,'antes-de-restaurar',t); t+=1000; }
  purgarCopias(dir, 14);
  const man = fs.readdirSync(dir).filter((f)=>f.startsWith('webhub-manual-')).length;
  const ant = fs.readdirSync(dir).filter((f)=>f.startsWith('webhub-antes-de-restaurar-')).length;
  assert.equal(man, 10);
  assert.equal(ant, 5);
});

test('purgarCopias no borra ultima ni archivos ajenos ni subcarpetas ni tmp', () => {
  const dir = tmpDir();
  for (let i=1;i<=15;i++){
    const db = mkDbWithData();
    hacerCopia(db, dir, 'diaria', Date.UTC(2025,0,i));
  }
  fs.writeFileSync(path.join(dir,'notas.txt'),'x');
  fs.writeFileSync(path.join(dir,'webhub-2026-13-45.sqlite'),'x');
  fs.mkdirSync(path.join(dir,'webhub-2026-01-01.sqlite'));
  fs.writeFileSync(path.join(dir,'.tmp-x.sqlite'),'x');
  const before = fs.readdirSync(dir).slice().sort();
  const borrados = purgarCopias(dir, 14);
  // ninguno de los protegidos borrado
  assert.ok(fs.existsSync(path.join(dir,'webhub-ultima.sqlite')));
  assert.ok(fs.existsSync(path.join(dir,'notas.txt')));
  assert.ok(fs.existsSync(path.join(dir,'webhub-2026-13-45.sqlite')));
  assert.ok(fs.existsSync(path.join(dir,'webhub-2026-01-01.sqlite')));
  assert.ok(fs.existsSync(path.join(dir,'.tmp-x.sqlite')));
  // el diario antiguo se borra
  assert.ok(borrados.includes('webhub-2025-01-01.sqlite'));
});

test('conservar invalido usa 14', () => {
  const dir = tmpDir();
  for (let i=0;i<5;i++){
    const db=mkDbWithData();
    hacerCopia(db,dir,'diaria',Date.UTC(2026,5,i+1));
  }
  for (const c of [0,-1,1.5,NaN]) {
    // reset? just call and check none deleted due to 5<=14
    const b = purgarCopias(dir, c as number);
    assert.equal(b.length, 0);
  }
});

test('listarCopias ordena de mas reciente a mas antigua y excluye ultima/temp', () => {
  const dir = tmpDir();
  const db1 = mkDbWithData();
  hacerCopia(db1, dir, 'diaria', Date.UTC(2026,0,1));
  const db2 = mkDbWithData();
  hacerCopia(db2, dir, 'manual', Date.UTC(2026,0,2,1,2,3));
  fs.writeFileSync(path.join(dir,'.tmp-foo.sqlite'),'x');
  const lista = listarCopias(dir);
  assert.ok(lista.every((x)=>x.archivo !== 'webhub-ultima.sqlite'));
  assert.ok(!lista.some((x)=>x.archivo.startsWith('.tmp-')));
  // más reciente primero
  assert.ok(lista.length >= 2);
  assert.ok(lista[0].fecha >= lista[1].fecha);
});

test('listarCopias devuelve [] si no hay directorio', () => {
  const dir = path.join(tmpDir(), 'nope');
  assert.deepEqual(listarCopias(dir), []);
});

test('estadoCopias basico', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  // sin copias
  let e = estadoCopias(db, dir, Date.now());
  assert.equal(e.aviso, true);
  assert.equal(e.ultimaOk, null);
  assert.equal(e.total, 0);
  // con copia reciente
  const ahora = Date.now();
  hacerCopia(db, dir, 'diaria', ahora);
  e = estadoCopias(db, dir, ahora + 3600_000);
  assert.equal(e.aviso, false);
  assert.ok(e.ultimaOk !== null);
  // 37h -> aviso
  e = estadoCopias(db, dir, ahora + 37*3600_000);
  assert.equal(e.aviso, true);
  assert.ok((e.horasDesdeUltima as number) > 36);
  // ultimoError
  ponerErr(db);
  e = estadoCopias(db, dir, ahora);
  assert.equal(e.ultimoError, 'boom');
  assert.ok(e.archivoEstable !== null);
});

function ponerErr(db: DatabaseSync) {
  // replicate settings upsert
  db.prepare("INSERT INTO settings (key,value) VALUES ('copia_ultimo_error','boom') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}

test('ProgramadorCopias revisar', async () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const clock = { now: Date.UTC(2026,0,1,12,0,0) };
  const reloj = () => clock.now;
  const prog = new ProgramadorCopias(db, dir, { conservar: 2, cadaMs: 10, primerAvisoMs: 10, reloj });
  // hace copia si no hay ninguna
  const c1 = prog.revisar();
  assert.ok(c1 !== null);
  assert.ok(fs.existsSync(path.join(dir, c1!.archivo)));
  // no hace si hay diaria reciente
  const c2 = prog.revisar();
  assert.equal(c2, null);
  // envejece archivo
  const diaria = listarCopias(dir).filter(x=>x.tipo==='diaria')[0];
  const fp = path.join(dir, diaria.archivo);
  const past = (clock.now - 25*3600_000)/1000;
  fs.utimesSync(fp, past, past);
  clock.now = clock.now + 1000;
  const c3 = prog.revisar();
  assert.ok(c3 !== null);
  // purga: dejar 4 días distintos + nueva = 5 -> conservar 2
  const dir2 = tmpDir();
  const db2 = mkDbWithData();
  for (let i=0;i<4;i++) hacerCopia(db2, dir2, 'diaria', Date.UTC(2026,0,i+1));
  const prog2 = new ProgramadorCopias(db2, dir2, { conservar: 2, reloj: () => Date.now() + 25*3600_000 });
  prog2.revisar();
  const rest = fs.readdirSync(dir2).filter(f=>/^webhub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f));
  assert.equal(rest.length, 2);
});

test('ProgramadorCopias fallo no lanza y guarda error, siguiente ok lo borra', () => {
  const db = mkDbWithData();
  const base = tmpDir();
  const bloqueante = path.join(base,'file');
  fs.writeFileSync(bloqueante,'x');
  const dir = path.join(bloqueante,'sub');
  const prog = new ProgramadorCopias(db, dir, { reloj: ()=>Date.now() });
  const origErr = console.error;
  let called = false;
  console.error = (...a:any[])=>{ called = true; };
  const r = prog.revisar();
  console.error = origErr;
  assert.equal(r, null);
  assert.ok(called);
  // error guardado
  const row = db.prepare("SELECT value FROM settings WHERE key='copia_ultimo_error'").get() as any;
  assert.ok(row && String(row.value).includes(' '));
  // ahora directorio válido: siguiente revisión correcta borra error
  const dir2 = path.join(base,'ok');
  fs.mkdirSync(dir2);
  const prog2 = new ProgramadorCopias(db, dir2, { reloj: ()=>Date.now() });
  prog2.revisar();
  const row2 = db.prepare("SELECT value FROM settings WHERE key='copia_ultimo_error'").get() as any;
  assert.equal(row2, undefined);
});

test('iniciar/detener con tiempos cortos hace copia sola', async () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const prog = new ProgramadorCopias(db, dir, { primerAvisoMs: 20, cadaMs: 1000, reloj: ()=>Date.now() });
  prog.iniciar();
  await new Promise((r)=>setTimeout(r,80));
  const files = fs.readdirSync(dir).filter(f=>/^webhub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f));
  assert.ok(files.length >= 1);
  prog.detener();
  // iniciar dos veces no duplica temporizadores
  const prog2 = new ProgramadorCopias(db, tmpDir(), { primerAvisoMs: 10, cadaMs: 10 });
  prog2.iniciar();
  prog2.iniciar();
  prog2.detener();
});

test('WAL rows se copian coherentemente', () => {
  const dirPath = tmpDir();
  const db = openDatabase(dirPath);
  // Inserta datos y deja WAL
  db.exec('PRAGMA journal_mode=WAL;');
  const repo = new Repo(db);
  const fam = repo.createFamily({name:'W'});
  repo.createLink({familyId:fam.id, url:'https://x.test', title:'X'});
  const outDir = tmpDir();
  const info = hacerCopia(db, outDir, 'diaria', Date.now());
  const copy = new DatabaseSync(path.join(outDir, info.archivo), { readOnly: true });
  try {
    const n = (copy.prepare('SELECT COUNT(*) n FROM links').get() as any).n;
    assert.equal(n, 1);
    const ic = copy.prepare('PRAGMA integrity_check').get() as any;
    assert.equal(ic.integrity_check,'ok');
  } finally { copy.close(); }
  db.close();
});
import { spawnSync } from 'node:child_process';

/** Envuelve una base real para estropear la copia justo después de VACUUM INTO. */
function conCopiaEstropeada(db: DatabaseSync, estropear: (ruta: string) => void): DatabaseSync {
  return new Proxy(db, {
    get(objetivo, prop) {
      const valor = (objetivo as any)[prop];
      if (typeof valor !== 'function') return valor;
      if (prop === 'exec') {
        return (sql: string) => {
          const r = objetivo.exec(sql);
          const m = /VACUUM INTO '(.*)'$/.exec(sql);
          if (m) estropear(m[1]!.replace(/''/g, "'"));
          return r;
        };
      }
      return valor.bind(objetivo);
    },
  });
}

function sinTemporales(dir: string): boolean {
  return fs.readdirSync(dir).every((n) => !n.startsWith('.tmp-'));
}

test('verificación: una copia con filas que no coinciden se rechaza, no deja temporales y conserva la última buena', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const buena = hacerCopia(db, dir, 'diaria', Date.UTC(2026, 0, 10, 3));
  const antes = fs.readFileSync(path.join(dir, 'webhub-ultima.sqlite'));
  const mala = conCopiaEstropeada(db, (ruta) => { const c = new DatabaseSync(ruta); c.exec('DELETE FROM links'); c.close(); });
  assert.throws(() => hacerCopia(mala, dir, 'diaria', Date.UTC(2026, 0, 11, 3)), /filas|copia/i);
  assert.ok(sinTemporales(dir), 'sin temporales');
  assert.ok(!fs.existsSync(path.join(dir, 'webhub-2026-01-11.sqlite')), 'la copia mala no se publica');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'webhub-ultima.sqlite')), antes, 'la última buena no cambia');
  assert.ok(fs.existsSync(path.join(dir, buena.archivo)));
});

test('verificación: una copia con otro user_version se rechaza', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const mala = conCopiaEstropeada(db, (ruta) => { const c = new DatabaseSync(ruta); c.exec('PRAGMA user_version = 999'); c.close(); });
  assert.throws(() => hacerCopia(mala, dir, 'manual', Date.UTC(2026, 0, 11, 3)), /user_version|copia/i);
  assert.ok(sinTemporales(dir));
  assert.equal(listarCopias(dir).length, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'webhub-ultima.sqlite')));
});

test('verificación: una copia con una página destrozada se rechaza', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const mala = conCopiaEstropeada(db, (ruta) => {
    const c = new DatabaseSync(ruta);
    const fila = c.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'links_family'").get() as { rootpage: number };
    const tam = (c.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    c.close();
    const fd = fs.openSync(ruta, 'r+');
    fs.writeSync(fd, Buffer.alloc(tam, 0xff), 0, tam, (fila.rootpage - 1) * tam);
    fs.closeSync(fd);
  });
  assert.throws(() => hacerCopia(mala, dir, 'diaria', Date.UTC(2026, 0, 12, 3)), /copia/i);
  assert.ok(sinTemporales(dir));
  assert.equal(listarCopias(dir).length, 0);
});

test('purgarCopias sin argumento conserva por defecto 14 diarias', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  for (let d = 1; d <= 20; d++) hacerCopia(db, dir, 'diaria', Date.UTC(2026, 0, d, 3));
  const borradas = purgarCopias(dir);
  assert.equal(borradas.length, 6);
  assert.equal(listarCopias(dir).filter((c) => c.tipo === 'diaria').length, 14);
  assert.ok(fs.existsSync(path.join(dir, 'webhub-2026-01-20.sqlite')));
  assert.ok(!fs.existsSync(path.join(dir, 'webhub-2026-01-06.sqlite')));
});

test('estadoCopias: el aviso salta pasadas 36 h, no antes (30 h no avisa)', () => {
  const db = mkDbWithData();
  const dir = tmpDir();
  const t0 = Date.UTC(2026, 0, 15, 3);
  hacerCopia(db, dir, 'diaria', t0);
  assert.equal(estadoCopias(db, dir, t0 + 30 * 3600_000).aviso, false);
  assert.equal(estadoCopias(db, dir, t0 + 35.9 * 3600_000).aviso, false);
  assert.equal(estadoCopias(db, dir, t0 + 36.1 * 3600_000).aviso, true);
});

test('ProgramadorCopias: iniciar dos veces no duplica la revisión', async () => {
  const db = mkDbWithData();
  const p = new ProgramadorCopias(db, tmpDir(), { primerAvisoMs: 20, cadaMs: 60_000 });
  let llamadas = 0;
  (p as any).revisar = () => { llamadas++; return null; };
  p.iniciar();
  p.iniciar();
  await new Promise((r) => setTimeout(r, 150));
  p.detener();
  assert.equal(llamadas, 1);
});

test('ProgramadorCopias: los temporizadores no impiden que el proceso termine (inicial e intervalo)', () => {
  const dir = tmpDir();
  const codigo = (primerAvisoMs: number, esperaMs: number) => `
    import { openDatabase } from ${JSON.stringify(path.resolve('src/server/db.ts'))};
    import { ProgramadorCopias } from ${JSON.stringify(path.resolve('src/server/copias.ts'))};
    const db = openDatabase(null);
    new ProgramadorCopias(db, ${JSON.stringify(dir)}, { primerAvisoMs: ${primerAvisoMs}, cadaMs: 600000 }).iniciar();
    await new Promise((r) => setTimeout(r, ${esperaMs}));
  `;
  for (const [primero, espera] of [[600000, 100], [10, 400]] as const) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', codigo(primero, espera)], { timeout: 8000, encoding: 'utf8' });
    assert.equal(r.error, undefined, `no se cuelga (primerAvisoMs ${primero}): ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
  }
});
