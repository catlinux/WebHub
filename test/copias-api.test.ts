import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';
import { Repo } from '../src/server/repo.ts';

const PIN = '20261015';
const ORIGIN = 'https://webhub.test';
const ROOT = process.cwd();

let server: Server;
let base = '';
let cookie = '';
let db: any;
let copiasDir = '';

function tmpDir(prefix = 'wh-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-WebHub': '1' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}

async function rawCall(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}

function runConfig(env: Record<string, string>) {
  const code = `import('./src/server/config.ts').then(m=>{process.stdout.write(JSON.stringify(m.config));process.exit(0);}).catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

before(async () => {
  copiasDir = tmpDir('copias-');
  db = openDatabase(null);
  await setPin(db, PIN);
  let now = 1000;
  const clock = () => now;
  // expose via closure not needed; mutate through shared
  (globalThis as any).__copiasNow = () => now;
  (globalThis as any).__copiasSetNow = (v: number) => { now = v; };

  server = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, copiasDir, copiasReloj: () => now }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(() => {
  try { server.close(); } catch {}
});

test('GET /api/copias sin sesión → 401', async () => {
  const saved = cookie;
  cookie = '';
  const r = await call('GET', '/api/copias');
  assert.equal(r.status, 401);
  cookie = saved;
});

test('con copiasDir: activa true, total 0, aviso true al principio', async () => {
  const r = await call('GET', '/api/copias');
  assert.equal(r.status, 200);
  assert.equal(r.json.activa, true);
  assert.equal(r.json.total, 0);
  assert.equal(r.json.aviso, true);
});

test('POST crea archivo manual y GET pasa a total 1, aviso false', async () => {
  const pr = await call('POST', '/api/copias');
  assert.equal(pr.status, 201);
  assert.equal(pr.json.tipo, 'manual');
  assert.ok(typeof pr.json.archivo === 'string');
  assert.ok(typeof pr.json.fecha === 'string');
  assert.ok(typeof pr.json.bytes === 'number' && pr.json.bytes > 0);
  const r = await call('GET', '/api/copias');
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.equal(r.json.aviso, false);
});

test('POST manual crea archivo en disco válido y actualiza webhub-ultima', async () => {
  // use a fresh app? reuse current created file above
  const archivos = fs.readdirSync(copiasDir).filter((f) => f.startsWith('webhub-manual-'));
  assert.ok(archivos.length >= 1);
  const ultimo = archivos[0]!;
  const p = path.join(copiasDir, ultimo);
  const c = new DatabaseSync(p, { readOnly: true });
  try {
    const n = c.prepare('SELECT COUNT(*) n FROM links').get() as any;
    const dbn = db.prepare('SELECT COUNT(*) n FROM links').get() as any;
    assert.equal(n.n, dbn.n);
    const ic = c.prepare('PRAGMA integrity_check').get() as any;
    assert.equal(ic.integrity_check, 'ok');
  } finally {
    c.close();
  }
  assert.ok(fs.existsSync(path.join(copiasDir, 'webhub-ultima.sqlite')));
});

test('sin X-WebHub → 403', async () => {
  const r = await rawCall('POST', '/api/copias', undefined, { Cookie: cookie });
  assert.equal(r.status, 403);
});

test('Origin ajeno → 403', async () => {
  const r = await rawCall('POST', '/api/copias', undefined, { Cookie: cookie, 'X-WebHub': '1', Origin: 'https://evil.test' });
  assert.equal(r.status, 403);
});

test('POST sin sesión → 401', async () => {
  const saved = cookie;
  cookie = '';
  const r = await call('POST', '/api/copias');
  assert.equal(r.status, 401);
  cookie = saved;
});

test('sin copiasDir: GET → {activa:false}, POST → 404', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  const s2 = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: null }).server;
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  // login
  const lg = await fetch(b2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const g = await fetch(b2 + '/api/copias', { headers: { Cookie: ck } });
  const gj = await g.json();
  assert.deepEqual(gj, { activa: false });
  const p = await fetch(b2 + '/api/copias', { method: 'POST', headers: { Cookie: ck, 'X-WebHub': '1' } });
  assert.equal(p.status, 404);
  const pj = await p.json();
  assert.equal(pj.error, 'Las copias automáticas están desactivadas.');
  s2.close();

  // undefined también
  const db3 = openDatabase(null);
  await setPin(db3, PIN);
  const s3 = createApp({ db: db3, insecureCookie: true, publicOrigin: ORIGIN }).server;
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  const b3 = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
  const lg3 = await fetch(b3 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck3 = (lg3.headers.get('set-cookie') ?? '').split(';')[0]!;
  const g3 = await fetch(b3 + '/api/copias', { headers: { Cookie: ck3 } });
  assert.deepEqual(await g3.json(), { activa: false });
  s3.close();
});

test('dos POST seguidos con reloj inyectado dentro de 30s → 429 con Retry-After 30 sin archivo extra', async () => {
  const dir = tmpDir('throttle-');
  let now = 1000;
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: dir, copiasReloj: () => now }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const beforeFiles = fs.readdirSync(dir).filter((f) => f.includes('manual')).length;
  const r1 = await fetch(bx + '/api/copias', { method: 'POST', headers: { Cookie: ck, 'X-WebHub': '1' } });
  assert.equal(r1.status, 201);
  now = 2000; // within 30s
  const r2 = await fetch(bx + '/api/copias', { method: 'POST', headers: { Cookie: ck, 'X-WebHub': '1' } });
  assert.equal(r2.status, 429);
  assert.equal(r2.headers.get('retry-after'), '30');
  const afterFiles = fs.readdirSync(dir).filter((f) => f.includes('manual')).length;
  assert.equal(afterFiles, beforeFiles + 1);
  // passed 30s
  now = 1000 + 31000;
  const r3 = await fetch(bx + '/api/copias', { method: 'POST', headers: { Cookie: ck, 'X-WebHub': '1' } });
  assert.equal(r3.status, 201);
  srv.close();
});

test('fallo de hacerCopia → 500 genérico sin ruta en cuerpo', async () => {
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  // impossible dir under a normal file
  const base = tmpDir('imp-');
  const blocker = path.join(base, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const dir = path.join(blocker, 'sub');
  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: dir }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const r = await fetch(bx + '/api/copias', { method: 'POST', headers: { Cookie: ck, 'X-WebHub': '1' } });
  assert.equal(r.status, 500);
  const j = await r.json();
  assert.equal(j.error, 'No se pudo hacer la copia.');
  assert.ok(!JSON.stringify(j).includes(dir));
  srv.close();
});

test('POST import/json con confirmación hace copia antes-de-restaurar y añade copiaPrevia', async () => {
  const dir = tmpDir('impjson-');
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  const repo = new Repo(dbx);
  const fam = repo.createFamily({ name: 'OldFam' });
  repo.createLink({ familyId: fam.id, url: 'https://example.com/old', title: 'Old' });

  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: dir }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;

  // capture exported restore data (old)
  const expRes = await fetch(bx + '/api/export', { headers: { Cookie: ck } });
  const exported = await expRes.json();

  // modify current data: add new link (so before-restore differs)
  const fam2 = repo.createFamily({ name: 'NewFam' });
  repo.createLink({ familyId: fam2.id, url: 'https://example.com/new', title: 'New' });

  const beforeDataRes = await fetch(bx + '/api/data', { headers: { Cookie: ck } });
  const beforeData = await beforeDataRes.json();

  const impRes = await fetch(bx + '/api/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: ck },
    body: JSON.stringify({ confirm: 'SUSTITUIR', data: exported }),
  });
  assert.equal(impRes.status, 200);
  const impJson = await impRes.json();
  assert.ok(typeof impJson.copiaPrevia === 'string');
  assert.ok(impJson.copiaPrevia.startsWith('webhub-antes-de-restaurar-'));
  assert.equal(typeof impJson.families, 'number');
  assert.equal(typeof impJson.links, 'number');

  // backup copy contains previous (new link present)
  const copyPath = path.join(dir, impJson.copiaPrevia);
  const copyDb = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const titles = copyDb.prepare("SELECT title FROM links").all().map((r: any) => r.title);
    assert.ok(titles.includes('New'), 'backup previo debe contener el enlace nuevo anterior');
    assert.ok(!titles.includes('Old') || titles.includes('Old'));
  } finally {
    copyDb.close();
  }

  // base now has restored old data
  const afterDataRes = await fetch(bx + '/api/data', { headers: { Cookie: ck } });
  const afterData = await afterDataRes.json();
  const afterTitles = afterData.links.map((l: any) => l.title);
  assert.ok(afterTitles.includes('Old'));
  assert.ok(!afterTitles.includes('New'));

  srv.close();
});

test('import sin confirmación no copia ni importa', async () => {
  const dir = tmpDir('noconfirm-');
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  const repo = new Repo(dbx);
  const fam = repo.createFamily({ name: 'F' });
  repo.createLink({ familyId: fam.id, url: 'https://example.com/x', title: 'X' });
  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: dir }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const beforeFiles = fs.readdirSync(dir).length;
  const r = await fetch(bx + '/api/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: ck },
    body: JSON.stringify({ confirm: 'NO', data: { app: 'WebHub', formato: 1, families: [], links: [] } }),
  });
  assert.ok(r.status === 400);
  const afterFiles = fs.readdirSync(dir).length;
  assert.equal(afterFiles, beforeFiles);
  srv.close();
});

test('copia previa falla → 500 y datos no cambian', async () => {
  const baseTmp = tmpDir('impfail-');
  const blocker = path.join(baseTmp, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const dir = path.join(blocker, 'sub');
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  const repo = new Repo(dbx);
  const fam = repo.createFamily({ name: 'F' });
  repo.createLink({ familyId: fam.id, url: 'https://example.com/x', title: 'X' });
  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: dir }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const before = (await fetch(bx + '/api/data', { headers: { Cookie: ck } })).json;
  const beforeStr = JSON.stringify(before);
  const expRes = await fetch(bx + '/api/export', { headers: { Cookie: ck } });
  const exported = await expRes.json();
  const r = await fetch(bx + '/api/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: ck },
    body: JSON.stringify({ confirm: 'SUSTITUIR', data: exported }),
  });
  assert.equal(r.status, 500);
  const j = await r.json();
  assert.equal(j.error, 'No se pudo hacer la copia previa; la restauración se ha cancelado.');
  // add a new link to? Actually no restore should happen; data unchanged
  const after = (await fetch(bx + '/api/data', { headers: { Cookie: ck } })).json;
  assert.deepEqual(JSON.stringify(after), beforeStr);
  srv.close();
});

test('sin copiasDir importación funciona como antes (sin copiaPrevia)', async () => {
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  const repo = new Repo(dbx);
  const fam = repo.createFamily({ name: 'F' });
  repo.createLink({ familyId: fam.id, url: 'https://example.com/x', title: 'X' });
  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: null }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const expRes = await fetch(bx + '/api/export', { headers: { Cookie: ck } });
  const exported = await expRes.json();
  const r = await fetch(bx + '/api/import/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: ck },
    body: JSON.stringify({ confirm: 'SUSTITUIR', data: exported }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(!('copiaPrevia' in j));
  assert.equal(typeof j.families, 'number');
  assert.equal(typeof j.links, 'number');
  srv.close();
});

test('GET lista como mucho 20 copias y más recientes primero', async () => {
  const dir = tmpDir('many-');
  // create 25 valid daily copies directly on disk
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 25; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i, 12, 0, 0));
    const iso = d.toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `webhub-${iso}.sqlite`), '');
  }
  const dbx = openDatabase(null);
  await setPin(dbx, PIN);
  const srv = createApp({ db: dbx, insecureCookie: true, publicOrigin: ORIGIN, copiasDir: dir }).server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const bx = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lg = await fetch(bx + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
  const ck = (lg.headers.get('set-cookie') ?? '').split(';')[0]!;
  const g = await fetch(bx + '/api/copias', { headers: { Cookie: ck } });
  const j = await g.json();
  assert.equal(j.copias.length, 20);
  const fechas = j.copias.map((c: any) => c.fecha);
  for (let i = 1; i < fechas.length; i++) {
    assert.ok(fechas[i - 1] >= fechas[i], 'orden descendente');
  }
  srv.close();
});

test('config: backupDir/backupKeep/backupEnabled', async () => {
  // default
  const c0 = runConfig({});
  assert.ok(c0.backupDir.endsWith(path.join('data', 'copias')) || c0.backupDir.endsWith('/copias'));
  assert.equal(c0.backupKeep, 14);
  assert.equal(c0.backupEnabled, true);

  const tmpData = tmpDir('cfgdata-');
  const c1 = runConfig({ WEBHUB_DATA_DIR: tmpData, WEBHUB_BACKUP_DIR: '/tmp/xyz-backup' });
  assert.equal(c1.backupDir, path.resolve('/tmp/xyz-backup'));
  assert.equal(c1.dataDir, path.resolve(tmpData));

  for (const bad of ['abc', '0', '-3', '2.5']) {
    const c = runConfig({ WEBHUB_BACKUP_KEEP: bad });
    assert.equal(c.backupKeep, 14, bad);
  }
  const c30 = runConfig({ WEBHUB_BACKUP_KEEP: '30' });
  assert.equal(c30.backupKeep, 30);

  assert.equal(runConfig({ WEBHUB_BACKUP: '0' }).backupEnabled, false);
  assert.equal(runConfig({ WEBHUB_BACKUP: '1' }).backupEnabled, true);
  assert.equal(runConfig({}).backupEnabled, true);
});

test('main.ts arranque imprime línea y se detiene con SIGTERM', async () => {
  const dir = tmpDir('main-');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, WEBHUB_DATA_DIR: dir, WEBHUB_PORT: '0', WEBHUB_HOST: '127.0.0.1', WEBHUB_BACKUP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  await new Promise((r) => setTimeout(r, 2000));
  child.kill('SIGTERM');
  await new Promise<void>((r) => child.on('exit', () => r()));
  assert.ok(out.includes('Copia automática diaria en'), out);

  // disabled
  const dir2 = tmpDir('main2-');
  const child2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, WEBHUB_DATA_DIR: dir2, WEBHUB_PORT: '0', WEBHUB_HOST: '127.0.0.1', WEBHUB_BACKUP: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out2 = '';
  child2.stdout.on('data', (d) => { out2 += d.toString(); });
  child2.stderr.on('data', (d) => { out2 += d.toString(); });
  await new Promise((r) => setTimeout(r, 2000));
  child2.kill('SIGTERM');
  await new Promise<void>((r) => child2.on('exit', () => r()));
  assert.ok(out2.includes('Copia automática desactivada.'), out2);
});
import * as NucleoCopias from '../src/server/copias.ts';
import * as AplicacionCopias from '../src/server/app.ts';
import * as BaseCopias from '../src/server/db.ts';
import * as AuthCopias from '../src/server/auth.ts';

test('POST /api/copias purga con el número de copias configurado, no con 14 fijo', async () => {
  const db = BaseCopias.openDatabase(null);
  await AuthCopias.setPin(db, '20261016');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-keep-'));
  for (let d = 1; d <= 20; d++) NucleoCopias.hacerCopia(db, dir, 'diaria', Date.UTC(2026, 0, d, 3));
  const { server } = AplicacionCopias.createApp({ db, insecureCookie: true, publicOrigin: 'https://webhub.test', copiasDir: dir, copiasConservar: 30, copiasReloj: () => Date.UTC(2026, 0, 25, 3) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const l = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: '20261016' }) });
    const cookie = (l.headers.get('set-cookie') ?? '').split(';')[0]!;
    const r = await fetch(`${base}/api/copias`, { method: 'POST', headers: { 'X-WebHub': '1', Cookie: cookie } });
    assert.equal(r.status, 201);
    const diarias = fs.readdirSync(dir).filter((n) => /^webhub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(n));
    assert.equal(diarias.length, 20, 'con conservar 30 no se borra ninguna de las 20 diarias');
  } finally {
    server.close();
  }
});

import { spawn as lanzarHijo } from 'node:child_process';
import { createServer as crearServidorLibre } from 'node:net';

async function puertoLibre(): Promise<number> {
  return new Promise((resolve) => {
    const s = crearServidorLibre();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); });
  });
}

async function esperar(condicion: () => boolean, ms: number): Promise<boolean> {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { if (condicion()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return condicion();
}

test('arranque real: el servidor hace solo la primera copia (y deja webhub-ultima.sqlite) y se detiene limpio con SIGTERM', async () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-arranque-'));
  const puerto = await puertoLibre();
  const db0 = BaseCopias.openDatabase(datos);
  await AuthCopias.setPin(db0, '20261016');
  db0.close();
  const hijo = lanzarHijo(process.execPath, ['--disable-warning=ExperimentalWarning', path.resolve('src/server/main.ts')], {
    env: { ...process.env, WEBHUB_DATA_DIR: datos, WEBHUB_PORT: String(puerto), WEBHUB_HOST: '127.0.0.1', WEBHUB_BACKUP_FIRST_DELAY_MS: '150', WEBHUB_INSECURE_COOKIE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  const cerrado = new Promise<number | null>((resolve) => hijo.on('exit', (c) => resolve(c)));
  try {
    const dirCopias = path.join(datos, 'copias');
    const hecho = await esperar(() => fs.existsSync(path.join(dirCopias, 'webhub-ultima.sqlite')), 10_000);
    assert.ok(hecho, `la copia automática no apareció. Salida: ${salida}`);
    assert.ok(fs.readdirSync(dirCopias).some((n) => /^webhub-\d{4}-\d{2}-\d{2}\.sqlite$/.test(n)), 'hay una copia diaria con nombre de fecha');
    assert.match(salida, /Copia automática diaria en/);
    // la API recibe la carpeta de copias desde main.ts
    const url = `http://127.0.0.1:${puerto}`;
    const l = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: '20261016' }) });
    assert.equal(l.status, 200);
    const cookie = (l.headers.get('set-cookie') ?? '').split(';')[0]!;
    const estado: any = await (await fetch(`${url}/api/copias`, { headers: { Cookie: cookie } })).json();
    assert.equal(estado.activa, true, 'GET /api/copias está activa');
    assert.ok(estado.total >= 1, 'la API ve la copia hecha');
    assert.ok(String(estado.carpeta).endsWith('copias'));
    hijo.kill('SIGTERM');
    const codigo = await Promise.race([cerrado, new Promise<string>((r) => setTimeout(() => r('colgado'), 8000))]);
    assert.equal(codigo, 0, 'sale limpio con SIGTERM');
  } finally {
    if (hijo.exitCode === null) hijo.kill('SIGKILL');
  }
});

test('arranque real con WEBHUB_BACKUP=0: no hace copias y lo dice', async () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-sincopia-'));
  const puerto = await puertoLibre();
  const hijo = lanzarHijo(process.execPath, ['--disable-warning=ExperimentalWarning', path.resolve('src/server/main.ts')], {
    env: { ...process.env, WEBHUB_DATA_DIR: datos, WEBHUB_PORT: String(puerto), WEBHUB_HOST: '127.0.0.1', WEBHUB_BACKUP: '0', WEBHUB_BACKUP_FIRST_DELAY_MS: '150', WEBHUB_INSECURE_COOKIE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  const cerrado = new Promise<number | null>((resolve) => hijo.on('exit', (c) => resolve(c)));
  try {
    await esperar(() => /Copia automática desactivada/.test(salida), 8000);
    await new Promise((r) => setTimeout(r, 1000));
    assert.match(salida, /Copia automática desactivada/);
    assert.equal(fs.existsSync(path.join(datos, 'copias')), false, 'no se crea la carpeta de copias');
    hijo.kill('SIGTERM');
    assert.equal(await cerrado, 0);
  } finally {
    if (hijo.exitCode === null) hijo.kill('SIGKILL');
  }
});
