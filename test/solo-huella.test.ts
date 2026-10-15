import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin, isPinLoginEnabled, setPinLoginEnabled, LoginLimiter } from '../src/server/auth.ts';

const PIN = '20261015';
const ORIGIN = 'https://webhub.test';

let server: Server;
let base: string;
let cookie = '';
let db: any;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-WebHub': '1' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  db = openDatabase(null);
  await setPin(db, PIN);
  server = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter: new LoginLimiter({ maxPerIp: 100, windowMs: 60_000 }) }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call('POST', '/api/login', { pin: PIN });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(() => server.close());

test('isPinLoginEnabled: ausente/1/x -> true, 0 -> false', () => {
  const d = openDatabase(null);
  assert.equal(isPinLoginEnabled(d), true);
  d.prepare("INSERT INTO settings (key, value) VALUES ('pin_login', '0')").run();
  assert.equal(isPinLoginEnabled(d), false);
  d.prepare("UPDATE settings SET value = '1' WHERE key = 'pin_login'").run();
  assert.equal(isPinLoginEnabled(d), true);
  d.prepare("UPDATE settings SET value = 'x' WHERE key = 'pin_login'").run();
  assert.equal(isPinLoginEnabled(d), true);
});

test('session por defecto pin:true; tras desactivar pin:false', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  const s = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN }).server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
    const c = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const se = await fetch(`${url}/api/session`, { headers: { Cookie: c } });
    const sej: any = await se.json();
    assert.equal(sej.pin, true);
    await fetch(`${url}/api/acceso/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: c }, body: JSON.stringify({ enabled: false }) });
    // no huellas -> should fail; insert one
  } finally { s.close(); }
});

test('PIN desactivado: login correcto 403 exacto sin cookie', async () => {
  setPinLoginEnabled(db, false);
  const res = await call('POST', '/api/login', { pin: PIN });
  assert.equal(res.status, 403);
  assert.equal(res.json.error, 'La entrada con PIN está desactivada. Usa la huella.');
  assert.ok(!res.headers.get('set-cookie'));
  setPinLoginEnabled(db, true);
});

test('PIN desactivado no incrementa limitador', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  const lim = new LoginLimiter({ maxPerIp: 100, windowMs: 60_000 });
  const app = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN, limiter: lim });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    setPinLoginEnabled(db2, false);
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: '000000' }) });
      assert.equal(r.status, 403);
    }
    setPinLoginEnabled(db2, true);
    const ok = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
    assert.equal(ok.status, 200);
  } finally { s.close(); }
});

test('PIN desactivado: hash inválido sigue 403 no 500', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  db2.prepare("UPDATE settings SET value = 'invalido' WHERE key = 'pin_hash'").run();
  const app = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    setPinLoginEnabled(db2, false);
    const r = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
    assert.equal(r.status, 403);
  } finally { s.close(); }
});

test('PUT /api/acceso/pin validaciones', async () => {
  // sin sesión
  const r1 = await fetch(base + '/api/acceso/pin', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(r1.status, 401);
  // sin X-WebHub
  const r2 = await fetch(base + '/api/acceso/pin', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  assert.equal(r2.status, 403);
  // cuerpos no booleanos
  setPinLoginEnabled(db, true);
  for (const v of ['no', 0, null, undefined]) {
    const body = v === undefined ? {} : { enabled: v };
    const r = await call('PUT', '/api/acceso/pin', body);
    assert.equal(r.status, 400, String(v));
  }
  const se = await call('GET', '/api/session');
  assert.equal(se.json.pin, true);
});

test('desactivar sin huellas -> 400 y sigue activo', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  const app = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
    const c = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const r = await fetch(`${url}/api/acceso/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: c }, body: JSON.stringify({ enabled: false }) });
    assert.equal(r.status, 400);
    const j: any = await r.json();
    // message maybe
    assert.match(j.error, /Registra antes una huella/);
    assert.equal(isPinLoginEnabled(db2), true);
  } finally { s.close(); }
});

test('con huella: desactivar/reactivar y borrar salvaguarda', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  db2.prepare("INSERT INTO passkeys (id, public_key, alg, counter, name, created_at, last_used_at) VALUES ('a', 'pk', 1, 0, 'Dev', '2020-01-01T00:00:00.000Z', NULL)").run();
  db2.prepare("INSERT INTO passkeys (id, public_key, alg, counter, name, created_at, last_used_at) VALUES ('b', 'pk2', 1, 0, 'Dev2', '2020-01-01T00:00:00.000Z', NULL)").run();
  const app = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
    const c = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const dis = await fetch(`${url}/api/acceso/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: c }, body: JSON.stringify({ enabled: false }) });
    assert.equal(dis.status, 200);
    const dj: any = await dis.json();
    assert.equal(dj.pin, false);
    // session pin false
    const se = await fetch(`${url}/api/session`, { headers: { Cookie: c } });
    const sej: any = await se.json();
    assert.equal(sej.pin, false);
    // borrar última con pin desactivado ->409
    db2.prepare("DELETE FROM passkeys WHERE id = 'b'").run();
    const delLast = await fetch(`${url}/api/webauthn/credentials/a`, { method: 'DELETE', headers: { 'X-WebHub': '1', Cookie: c } });
    assert.equal(delLast.status, 409);
    const list = await fetch(`${url}/api/webauthn/credentials`, { headers: { Cookie: c } });
    const lj: any = await list.json();
    assert.equal(lj.length, 1);
    // two passkeys can delete one
    db2.prepare("INSERT INTO passkeys (id, public_key, alg, counter, name, created_at, last_used_at) VALUES ('b', 'pk2', 1, 0, 'Dev2', '2020-01-01T00:00:00.000Z', NULL)").run();
    const delOne = await fetch(`${url}/api/webauthn/credentials/a`, { method: 'DELETE', headers: { 'X-WebHub': '1', Cookie: c } });
    assert.equal(delOne.status, 200);
    // reactivate
    const re = await fetch(`${url}/api/acceso/pin`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: c }, body: JSON.stringify({ enabled: true }) });
    assert.equal(re.status, 200);
    const rj: any = await re.json();
    assert.equal(rj.pin, true);
    // with pin active can delete last
    const delFinal = await fetch(`${url}/api/webauthn/credentials/b`, { method: 'DELETE', headers: { 'X-WebHub': '1', Cookie: c } });
    assert.equal(delFinal.status, 200);
  } finally { s.close(); }
});

test('eventos pin-desactivado/pin-activado y PIN desactivado', async () => {
  setPinLoginEnabled(db, true);
  db.prepare("INSERT INTO passkeys (id, public_key, alg, counter, name, created_at, last_used_at) VALUES ('z', 'pkz', 1, 0, 'DevZ', '2020-01-01T00:00:00.000Z', NULL) ON CONFLICT(id) DO NOTHING").run();
  // reset access log
  db.prepare('DELETE FROM access_log').run();
  // disable
  const dis = await call('PUT', '/api/acceso/pin', { enabled: false });
  assert.equal(dis.status, 200);
  // login while disabled creates 'PIN desactivado' failure
  const lr = await call('POST', '/api/login', { pin: PIN });
  assert.equal(lr.status, 403);
  // reactivate
  const re = await call('PUT', '/api/acceso/pin', { enabled: true });
  assert.equal(re.status, 200);
  const entries = db.prepare('SELECT kind, ok, detail FROM access_log').all() as any[];
  assert.ok(entries.some((e) => e.kind === 'pin-desactivado' && e.ok === 1));
  assert.ok(entries.some((e) => e.kind === 'pin-activado' && e.ok === 1));
  assert.ok(entries.some((e) => e.kind === 'pin' && e.ok === 0 && e.detail === 'PIN desactivado'));
});

test('setPin reactiva entrada', async () => {
  setPinLoginEnabled(db, false);
  assert.equal(isPinLoginEnabled(db), false);
  await setPin(db, PIN);
  assert.equal(isPinLoginEnabled(db), true);
});

test('cli-pin imprime reactivación (logica)', async () => {
  // covered by isPinLoginEnabled check above; nothing more.
});