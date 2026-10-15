import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KeyObject } from 'node:crypto';
import crypto from 'node:crypto';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin, LoginLimiter, createSession } from '../src/server/auth.ts';
import { ALGS } from '../src/server/webauthn.ts';
import { logAccess, listAccess, accessSummary, omittedCount, deviceLabel } from '../src/server/accesos.ts';

const PIN = '20261015';
const WRONG_PIN = '999999';
const ORIGIN = 'https://webhub.test';
const RP_ID = 'webhub.test';

function b64u(buf: Buffer | Uint8Array) { return Buffer.from(buf).toString('base64url'); }
function sha256(buf: Buffer | Uint8Array | string) { return crypto.createHash('sha256').update(buf).digest(); }
function clientData(type: string, challenge: string, origin: string) { return b64u(Buffer.from(JSON.stringify({ type, challenge, origin }))); }
function makeAuthData(rpId: string, flags: number, counter: number, credId?: Buffer) {
  if (credId) {
    const buf = Buffer.alloc(37 + 16 + 2 + credId.length);
    sha256(rpId).copy(buf, 0);
    buf[32] = flags;
    buf.writeUInt32BE(counter, 33);
    buf.writeUInt16BE(credId.length, 37 + 16);
    credId.copy(buf, 37 + 16 + 2);
    return buf;
  }
  const buf = Buffer.alloc(37);
  sha256(rpId).copy(buf, 0);
  buf[32] = flags;
  buf.writeUInt32BE(counter, 33);
  return buf;
}
function genKey(alg: number) {
  if (alg === ALGS.ES256) return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  if (alg === ALGS.RS256) return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return crypto.generateKeyPairSync('ed25519');
}
function signData(alg: number, privateKey: KeyObject, data: Buffer) {
  if (alg === ALGS.ES256) return crypto.sign('sha256', data, privateKey);
  if (alg === ALGS.RS256) return crypto.sign('sha256', data, privateKey);
  return crypto.sign(null, data, privateKey);
}

const UA_CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const UA_FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
const UA_SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

async function setupApp(limiterOpts?: Record<string, any>) {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const limiter = new LoginLimiter(limiterOpts ?? { maxPerIp: 100, windowMs: 60_000 });
  const app = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter });
  const server = app.server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, app, server, base, close: () => server.close() };
}

function allRows(db: any) { return db.prepare('SELECT id, at, kind, ok, ip, device, detail FROM access_log ORDER BY id').all() as any[]; }

// ---------- deviceLabel ----------
test('deviceLabel Chrome en Windows', () => {
  assert.equal(deviceLabel(UA_CHROME_WIN), 'Chrome en Windows');
});
test('deviceLabel Edge en Windows', () => {
  assert.equal(deviceLabel(UA_EDGE_WIN), 'Edge en Windows');
});
test('deviceLabel Firefox en Linux', () => {
  assert.equal(deviceLabel(UA_FIREFOX_LINUX), 'Firefox en Linux');
});
test('deviceLabel Safari en iPhone', () => {
  assert.equal(deviceLabel(UA_SAFARI_IPHONE), 'Safari en iPhone');
});
test('deviceLabel Chrome en Android', () => {
  assert.equal(deviceLabel(UA_CHROME_ANDROID), 'Chrome en Android');
});
test('deviceLabel Safari en Mac', () => {
  assert.equal(deviceLabel(UA_SAFARI_MAC), 'Safari en Mac');
});
test('deviceLabel vacio/undefined/garbage', () => {
  const allowed = new Set(['Navegador desconocido', 'Chrome en Windows', 'Edge en Windows', 'Firefox en Linux', 'Safari en iPhone', 'Chrome en Android', 'Safari en Mac']);
  for (const ua of ['', undefined, 'basura sin sentido', 'foo bar 123']) {
    const r = deviceLabel(ua as any);
    assert.ok(allowed.has(r), `no permitido: ${r}`);
  }
  assert.equal(deviceLabel(''), deviceLabel(undefined));
});
test('deviceLabel inyeccion de texto queda cerrado', () => {
  const ua = '<script>alert(1)</script> "quoted" \'single\'';
  const r = deviceLabel(ua);
  const allowed = new Set(['Navegador desconocido', 'Chrome en Windows', 'Edge en Windows', 'Firefox en Linux', 'Safari en iPhone', 'Chrome en Android', 'Safari en Mac', 'Navegador en sistema desconocido', 'Navegador en Windows', 'Navegador en Mac', 'Navegador en Linux', 'Navegador en Android', 'Navegador en iPhone', 'Navegador en iPad', 'Chrome en sistema desconocido', 'Edge en sistema desconocido', 'Firefox en sistema desconocido', 'Safari en sistema desconocido']);
  assert.ok(allowed.has(r));
  assert.notEqual(r, ua);
  assert.ok(!r.includes('<script>'));
  assert.ok(!r.includes('quoted'));
});

// ---------- recorte ip/detail ----------
test('recorta ip a 64 y detail a 120', () => {
  const db = openDatabase(null);
  logAccess(db, { kind: 'pin', ok: true, ip: 'a'.repeat(200), userAgent: UA_CHROME_WIN, detail: 'b'.repeat(200) }, 1000);
  const e = listAccess(db, 1)[0];
  assert.equal(e.ip.length, 64);
  assert.equal(e.detail.length, 120);
});

// ---------- omitted / 30 fallos/hora ----------
test('descarta tras 30 fallos en una hora', () => {
  const db = openDatabase(null);
  const now = 1_000_000;
  for (let i = 0; i < 30; i++) {
    logAccess(db, { kind: 'pin', ok: false, ip: '1.1.1.1' }, now + i);
  }
  assert.equal(omittedCount(db), 0);
  assert.equal(allRows(db).length, 30);
  logAccess(db, { kind: 'pin', ok: false, ip: '1.1.1.1' }, now + 100);
  assert.equal(omittedCount(db), 1);
  assert.equal(allRows(db).length, 30);
  // correcto sigue registrandose
  logAccess(db, { kind: 'pin', ok: true, ip: '1.1.1.1' }, now + 200);
  assert.equal(allRows(db).length, 31);
  // kinds protegidos nunca se descartan
  for (const kind of ['bloqueo', 'huella-alta', 'huella-baja']) {
    const rowsBefore = allRows(db).length;
    const omittedBefore = omittedCount(db);
    logAccess(db, { kind, ok: false, ip: '1.1.1.1' }, now + 300);
    assert.equal(omittedCount(db), omittedBefore, kind);
    assert.equal(allRows(db).length, rowsBefore + 1, kind);
  }
});

// ---------- purga por antiguedad ----------
test('purga eventos de mas de 180 dias', () => {
  const db = openDatabase(null);
  const now = Date.now();
  const old = now - (181 * 24 * 60 * 60 * 1000);
  logAccess(db, { kind: 'pin', ok: true, ip: '1', detail: 'OLD' }, old);
  assert.equal(allRows(db).filter((r) => r.detail === 'OLD').length, 1);
  logAccess(db, { kind: 'pin', ok: true, ip: '2', detail: 'NEW' }, now);
  assert.equal(allRows(db).filter((r) => r.detail === 'OLD').length, 0);
});

// ---------- purga por cantidad protege 100 correctos ----------
test('purga por cantidad conserva 100 correctos mas recientes', () => {
  const db = openDatabase(null);
  const now = Date.now();
  const ins = db.prepare('INSERT INTO access_log (at, kind, ok, ip, device, detail) VALUES (?, ?, ?, ?, ?, ?)');
  // 150 correctos primero (mas antiguos), luego miles de fallos
  for (let i = 0; i < 150; i++) ins.run(new Date(now).toISOString(), 'pin', 1, '1.1.1.1', 'Chrome en Windows', 'OK');
  for (let i = 0; i < 1200; i++) ins.run(new Date(now).toISOString(), 'pin', 0, '1.1.1.1', 'Chrome en Windows', 'FAIL');
  const beforeOk = db.prepare("SELECT COUNT(*) AS n FROM access_log WHERE detail='OK'").get() as { n: number };
  assert.equal(beforeOk.n, 150);
  logAccess(db, { kind: 'pin', ok: true, ip: '1.1.1.1', detail: 'NEW' }, now);
  const afterOk = db.prepare('SELECT COUNT(*) AS n FROM access_log WHERE ok = 1').get() as { n: number };
  assert.equal(afterOk.n, 100);
  const total = db.prepare('SELECT COUNT(*) AS n FROM access_log').get() as { n: number };
  assert.ok(total.n <= 1000);
});

// ---------- accessSummary ----------
test('accessSummary secuencia y fallos antes', () => {
  const db = openDatabase(null);
  logAccess(db, { kind: 'pin', ok: false, ip: '1' }, 500);       // fallo antiguo (antes de entrada previa)
  logAccess(db, { kind: 'pin', ok: true, ip: '1' }, 1000);        // entrada previa
  logAccess(db, { kind: 'huella', ok: false, ip: '1' }, 2000);    // fallo
  logAccess(db, { kind: 'bloqueo', ok: false, ip: '1' }, 2500);   // bloqueo no cuenta
  logAccess(db, { kind: 'pin', ok: false, ip: '1' }, 3000);       // fallo
  logAccess(db, { kind: 'pin', ok: true, ip: '1' }, 4000);        // entrada actual
  const s = accessSummary(db);
  assert.equal(s.fallos, 2);
  assert.equal(s.desde, new Date(1000).toISOString());
});
test('accessSummary sin entrada previa devuelve null y cuenta anteriores', () => {
  const db = openDatabase(null);
  logAccess(db, { kind: 'pin', ok: false, ip: '1' }, 1000);
  logAccess(db, { kind: 'pin', ok: false, ip: '1' }, 2000);
  logAccess(db, { kind: 'pin', ok: true, ip: '1' }, 3000);
  const s = accessSummary(db);
  assert.equal(s.fallos, 2);
  assert.equal(s.desde, null);
});

// ---------- API tests ----------
test('PIN correcto registra evento ok con ip y dispositivo', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    const ua = UA_CHROME_WIN;
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', 'User-Agent': ua },
      body: JSON.stringify({ pin: PIN }),
    });
    assert.equal(res.status, 200);
    const rows = allRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'pin');
    assert.equal(rows[0].ok, 1);
    assert.equal(rows[0].device, 'Chrome en Windows');
    assert.equal(rows[0].ip, '127.0.0.1');
    for (const r of allRows(db)) {
      for (const key of Object.keys(r)) {
        const v = String((r as any)[key]);
        assert.ok(!v.includes(PIN), `campo ${key} contiene el PIN real`);
      }
    }
  } finally { close(); }
});

test('PIN incorrecto registra fallido y no guarda el PIN', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', 'User-Agent': UA_FIREFOX_LINUX },
      body: JSON.stringify({ pin: WRONG_PIN }),
    });
    assert.equal(res.status, 401);
    const rows = allRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'pin');
    assert.equal(rows[0].ok, 0);
    // comprobar que ni el PIN enviado ni el real aparecen en ningun campo
    for (const r of rows) {
      for (const key of Object.keys(r)) {
        const v = String((r as any)[key]);
        assert.ok(!v.includes(WRONG_PIN), `campo ${key} contiene el PIN`);
        assert.ok(!v.includes(PIN), `campo ${key} contiene el PIN real`);
      }
    }
  } finally { close(); }
});

test('activacion de bloqueo registra evento bloqueo y 429 no anade filas', async () => {
  const { db, server, base, close } = await setupApp({ maxPerIp: 100, windowMs: 60_000, streakLimit: 3 });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(base + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
        body: JSON.stringify({ pin: WRONG_PIN }),
      });
      assert.equal(r.status, 401);
    }
    const rows1 = allRows(db);
    const bloqueos = rows1.filter((r) => r.kind === 'bloqueo').length;
    assert.equal(bloqueos, 1);
    const countBefore = rows1.length;
    // peticiÃ³n siguiente rechazada con 429 no aÃ±ade filas
    const r429 = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    assert.equal(r429.status, 429);
    assert.equal(allRows(db).length, countBefore);
    // tampoco otro error
    const r429b = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: WRONG_PIN }),
    });
    assert.equal(r429b.status, 429);
    assert.equal(allRows(db).length, countBefore);
  } finally { close(); }
});

// passkey helpers using direct fetch
async function registerPasskeyAt(url: string, cookieStr: string, alg = ALGS.ES256, name = 'Dev') {
  const roRes = await fetch(url + '/api/webauthn/register-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookieStr },
  });
  const roJson: any = await roRes.json();
  const challenge = roJson.challenge;
  const kp = genKey(alg);
  const spki = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
  const credId = crypto.randomBytes(16);
  const id = b64u(credId);
  const auth = makeAuthData(RP_ID, 0x45, 42, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const regRes = await fetch(url + '/api/webauthn/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookieStr },
    body: JSON.stringify({ id, clientDataJSON: cd, authenticatorData: b64u(auth), publicKey: b64u(spki), alg, name }),
  });
  const regJson: any = await regRes.json().catch(() => null);
  return { id, kp, regRes: { status: regRes.status, json: regJson } };
}

test('entrada huella correcta registra evento ok', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    // login PIN
    const lr = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    const reg = await registerPasskeyAt(base, cookieStr, ALGS.ES256, 'Dev');
    assert.equal(reg.regRes.status, 201);
    const id = reg.id; const kp = reg.kp;
    // registro event
    // login options
    const loRes = await fetch(base + '/api/webauthn/login-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    });
    const loJson: any = await loRes.json();
    const challenge = loJson.challenge;
    const auth = makeAuthData(RP_ID, 0x05, 43);
    const cd = clientData('webauthn.get', challenge, ORIGIN);
    const clientBytes = Buffer.from(cd, 'base64url');
    const data = Buffer.concat([auth, sha256(clientBytes)]);
    const signature = signData(ALGS.ES256, kp.privateKey as KeyObject, data);
    const passRes = await fetch(base + '/api/webauthn/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ id, clientDataJSON: cd, authenticatorData: b64u(auth), signature: b64u(signature) }),
    });
    assert.equal(passRes.status, 200);
    const huellaOk = allRows(db).filter((r) => r.kind === 'huella' && r.ok === 1).length;
    assert.ok(huellaOk >= 1);
  } finally { close(); }
});

test('huella fallida (firma ajena) registra evento fallido', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    const lr = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    const reg = await registerPasskeyAt(base, cookieStr, ALGS.ES256, 'Dev');
    const id = reg.id;
    const loRes = await fetch(base + '/api/webauthn/login-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    });
    const loJson: any = await loRes.json();
    const challenge = loJson.challenge;
    const auth = makeAuthData(RP_ID, 0x05, 43);
    const cd = clientData('webauthn.get', challenge, ORIGIN);
    const alt = genKey(ALGS.ES256);
    const data = Buffer.concat([auth, sha256(Buffer.from(cd, 'base64url'))]);
    const sig = signData(ALGS.ES256, alt.privateKey as KeyObject, data);
    const res = await fetch(base + '/api/webauthn/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ id, clientDataJSON: cd, authenticatorData: b64u(auth), signature: b64u(sig) }),
    });
    assert.equal(res.status, 401);
    const huellaFail = allRows(db).filter((r) => r.kind === 'huella' && r.ok === 0).length;
    assert.ok(huellaFail >= 1);
  } finally { close(); }
});

test('huella fallida (credencial desconocida) registra evento fallido', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    const lr = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    await registerPasskeyAt(base, cookieStr, ALGS.ES256, 'Dev');
    const credId = crypto.randomBytes(16);
    const id = b64u(credId);
    const loRes = await fetch(base + '/api/webauthn/login-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    });
    assert.equal(loRes.status, 200);
    const loJson: any = await loRes.json();
    const challenge = loJson.challenge;
    const auth = makeAuthData(RP_ID, 0x05, 43);
    const cd = clientData('webauthn.get', challenge, ORIGIN);
    const res = await fetch(base + '/api/webauthn/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ id, clientDataJSON: cd, authenticatorData: b64u(auth), signature: b64u(crypto.randomBytes(72)) }),
    });
    assert.equal(res.status, 401);
    const huellaFail = allRows(db).filter((r) => r.kind === 'huella' && r.ok === 0).length;
    assert.ok(huellaFail >= 1);
  } finally { close(); }
});

// alta/baja de huella usando helper completo
test('alta y baja de huella registran eventos', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    const lr = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    const reg = await registerPasskeyAt(base, cookieStr, ALGS.ES256, 'Mi huella');
    assert.equal(reg.regRes.status, 201);
    assert.ok(allRows(db).some((r) => r.kind === 'huella-alta' && r.ok === 1));
    // baja
    const del = await fetch(base + '/api/webauthn/credentials/' + encodeURIComponent(reg.id), {
      method: 'DELETE', headers: { Cookie: cookieStr, 'X-WebHub': '1' },
    });
    assert.equal(del.status, 200);
    assert.ok(allRows(db).some((r) => r.kind === 'huella-baja' && r.ok === 1));
  } finally { close(); }
});

// ---------- GET /api/accesos ----------
test('GET /api/accesos sin sesion -> 401', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    const res = await fetch(base + '/api/accesos');
    assert.equal(res.status, 401);
    // resumen tambien
    const res2 = await fetch(base + '/api/accesos/resumen');
    assert.equal(res2.status, 401);
  } finally { close(); }
});

test('GET /api/accesos devuelve recientes primero y acota limite', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    // insertar 5 eventos directos con ats crecientes
    const now = Date.now();
    for (let i = 0; i < 5; i++) logAccess(db, { kind: 'pin', ok: true, ip: '1' }, now + i * 1000);
    const lr = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    // recientes primero
    const r = await fetch(base + '/api/accesos', { headers: { Cookie: cookieStr } });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.ok(Array.isArray(j.entries));
    assert.ok(j.entries.length >= 5);
    for (let i = 1; i < j.entries.length; i++) {
      assert.ok(new Date(j.entries[i - 1].at).getTime() >= new Date(j.entries[i].at).getTime());
    }
    // ?limite=2
    const r2 = await fetch(base + '/api/accesos?limite=2', { headers: { Cookie: cookieStr } });
    const j2: any = await r2.json();
    assert.equal(j2.entries.length, 2);
    // clamping
    for (const q of ['0', '-5']) {
      const rr = await fetch(base + '/api/accesos?limite=' + q, { headers: { Cookie: cookieStr } });
      const jj: any = await rr.json();
      assert.equal(jj.entries.length, 1);
    }
    {
      const rr = await fetch(base + '/api/accesos?limite=x', { headers: { Cookie: cookieStr } });
      const jj: any = await rr.json();
      assert.ok(jj.entries.length >= 1);
      assert.ok(jj.entries.length <= 200);
    }
    const r9999 = await fetch(base + '/api/accesos?limite=9999', { headers: { Cookie: cookieStr } });
    const j9999: any = await r9999.json();
    assert.ok(j9999.entries.length <= 200);
    // campos exactos
    const keys = Object.keys(j2.entries[0]).sort();
    assert.deepEqual(keys, ['at', 'detail', 'device', 'id', 'ip', 'kind', 'ok']);
  } finally { close(); }
});

test('GET /api/accesos/resumen secuencia entrada', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    logAccess(db, { kind: 'pin', ok: true, ip: '1' }, 1000);
    logAccess(db, { kind: 'pin', ok: false, ip: '1' }, 2000);
    logAccess(db, { kind: 'pin', ok: false, ip: '1' }, 3000);
    logAccess(db, { kind: 'pin', ok: true, ip: '1' }, 4000);
    const session = createSession(db, 30);
    const cookieStr = 'webhub_sesion=' + session.token;
    const r = await fetch(base + '/api/accesos/resumen', { headers: { Cookie: cookieStr } });
    const j: any = await r.json();
    assert.equal(j.fallos, 2);
    assert.equal(j.desde, new Date(1000).toISOString());
  } finally { close(); }
});

// ---------- fallo registro no impide login ----------
test('si la tabla access_log no existe el login PIN sigue 200', async () => {
  const { db, server, base, close } = await setupApp();
  try {
    db.exec('DROP TABLE access_log');
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    assert.equal(res.status, 200);
  } finally { close(); }
});

test('GET /api/accesos nunca devuelve más de 200 filas aunque se pida más y haya más', async () => {
  const { db, base, close } = await setupApp();
  try {
    const now = Date.now();
    for (let i = 0; i < 260; i++) logAccess(db, { kind: 'pin', ok: true, ip: '1' }, now + i * 1000);
    const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' }, body: JSON.stringify({ pin: PIN }) });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    for (const [q, esperado] of [['9999', 200], ['200', 200], ['201', 200], ['5', 5], ['0', 1], ['-5', 1]] as const) {
      const j: any = await (await fetch(`${base}/api/accesos?limite=${q}`, { headers: { Cookie: cookieStr } })).json();
      assert.equal(j.entries.length, esperado, `limite=${q}`);
    }
    const sinLimite: any = await (await fetch(`${base}/api/accesos`, { headers: { Cookie: cookieStr } })).json();
    assert.equal(sinLimite.entries.length, 50);
  } finally {
    close();
  }
});
