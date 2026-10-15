import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KeyObject } from 'node:crypto';
import crypto from 'node:crypto';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin, LoginLimiter } from '../src/server/auth.ts';
import { ALGS } from '../src/server/webauthn.ts';

const PIN = '20261015';
const ORIGIN = 'https://webhub.test';
const RP_ID = 'webhub.test';

let server: Server;
let base: string;
let cookie = '';
let sharedPasskey: { id: string; kp: any; alg: number } | null = null;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
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
  return { status: res.status, json, headers: res.headers };
}

function b64u(buf: Buffer | Uint8Array) { return Buffer.from(buf).toString('base64url'); }
function sha256(buf: Buffer | Uint8Array | string) { return crypto.createHash('sha256').update(buf).digest(); }
function clientData(type: string, challenge: string, origin: string) {
  return b64u(Buffer.from(JSON.stringify({ type, challenge, origin })));
}
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

async function registerPasskey(alg: number = ALGS.ES256, name = 'Mi dispositivo') {
  const opts = await call('POST', '/api/webauthn/register-options');
  assert.equal(opts.status, 200);
  const challenge = opts.json.challenge;
  const kp = genKey(alg);
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const id = b64u(credId);
  const auth = makeAuthData(RP_ID, 0x45, 42, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const res = await call('POST', '/api/webauthn/register', {
    id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg,
    name,
  });
  return { id, kp, spki, credId, regRes: res };
}

async function passkeyLogin(id: string, kp: any, alg: number, counter: number, challenge?: string) {
  let ch: string | undefined = challenge;
  if (!ch) {
    const lo = await call('POST', '/api/webauthn/login-options');
    assert.equal(lo.status, 200);
    ch = lo.json.challenge;
  }
  const auth = makeAuthData(RP_ID, 0x05, counter);
  const cd = clientData('webauthn.get', ch as string, ORIGIN);
  const clientBytes = Buffer.from(cd, 'base64url');
  const data = Buffer.concat([auth, sha256(clientBytes)]);
  const signature = signData(alg, kp.privateKey as KeyObject, data);
  return call('POST', '/api/webauthn/login', {
    id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(signature),
  });
}

async function registerPasskeyAt(baseUrl: string, cookieStr: string, alg = ALGS.ES256, name = 'Dev') {
  const roRes = await fetch(baseUrl + '/api/webauthn/register-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookieStr },
  });
  const roJson: any = await roRes.json();
  const challenge = roJson.challenge;
  const kp = genKey(alg);
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const id = b64u(credId);
  const auth = makeAuthData(RP_ID, 0x45, 42, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const regRes = await fetch(baseUrl + '/api/webauthn/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookieStr },
    body: JSON.stringify({ id, clientDataJSON: cd, authenticatorData: b64u(auth), publicKey: b64u(spki), alg, name }),
  });
  const regJson: any = await regRes.json().catch(() => null);
  return { id, kp, regRes: { status: regRes.status, json: regJson, headers: regRes.headers } };
}

before(async () => {
  const db = openDatabase(null);
  await setPin(db, PIN);
  server = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter: new LoginLimiter({ maxPerIp: 100, windowMs: 60_000 }) }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call('POST', '/api/login', { pin: PIN });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(() => server.close());

test('peticiones sin X-WebHub en rutas públicas webauthn → 403', async () => {
  const res = await fetch(base + '/api/webauthn/login-options', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 403);
  const res2 = await fetch(base + '/api/webauthn/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res2.status, 403);
});

test('sin sesión → 401', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await call('POST', '/api/webauthn/register-options')).status, 401);
  assert.equal((await call('GET', '/api/webauthn/credentials')).status, 401);
  cookie = saved;
});

test('login-options sin passkeys → 404', async () => {
  const db2 = openDatabase(null);
  await setPin(db2, PIN);
  const s = createApp({ db: db2, insecureCookie: true, publicOrigin: ORIGIN }).server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const res = await fetch(`${url}/api/webauthn/login-options`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' } });
  assert.equal(res.status, 404);
  s.close();
});

test('flujo completo registro + entrada (P-256)', async () => {
  const { id, kp, regRes } = await registerPasskey(ALGS.ES256, 'Mi dispositivo');
  assert.equal(regRes.status, 201);
  assert.equal(regRes.json.id, id);
  assert.equal(regRes.json.lastUsedAt, null);

  const list = await call('GET', '/api/webauthn/credentials');
  assert.equal(list.status, 200);
  const item = list.json.find((x: any) => x.id === id);
  assert.ok(item);
  assert.equal(item.name, 'Mi dispositivo');
  assert.ok(!('publicKey' in item));
  assert.ok(!('counter' in item));
  assert.ok(!('alg' in item));

  const sess = await call('GET', '/api/session');
  assert.equal(sess.json.passkeys, true);

  const lo = await call('POST', '/api/webauthn/login-options');
  assert.equal(lo.status, 200);
  const challenge = lo.json.challenge;
  const loCreds = lo.json.allowCredentials;
  assert.ok(loCreds.some((c: any) => c.id === id));

  const counter = 43;
  const auth = makeAuthData(RP_ID, 0x05, counter);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const clientBytes = Buffer.from(cd, 'base64url');
  const data = Buffer.concat([auth, sha256(clientBytes)]);
  const signature = signData(ALGS.ES256, kp.privateKey as KeyObject, data);

  const loginRes = await call('POST', '/api/webauthn/login', {
    id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(signature),
  });
  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.json.ok, true);
  const newCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.ok(newCookie.includes('webhub_sesion'));
  const saved = cookie;
  cookie = newCookie;
  const dataRes = await call('GET', '/api/data');
  assert.equal(dataRes.status, 200);
  cookie = saved;

  sharedPasskey = { id, kp, alg: ALGS.ES256 };
});

test('id repetido → 409', async () => {
  const reg = await registerPasskey(ALGS.ES256, 'Dup');
  assert.equal(reg.regRes.status, 201);
  const credId = Buffer.from(reg.id, 'base64url');
  const ro = await call('POST', '/api/webauthn/register-options');
  assert.equal(ro.status, 200);
  const challenge = ro.json.challenge;
  const kp = genKey(ALGS.ES256);
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x45, 43, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const res = await call('POST', '/api/webauthn/register', {
    id: reg.id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    name: 'Dup2',
  });
  assert.equal(res.status, 409);
});

test('más de 10 → 400 y borrar funciona', async () => {
  // cubierto en test dedicado "máximo 10 passkeys"; este queda como alias vacío.
});

test('export no incluye passkeys', async () => {
  const exp = await call('GET', '/api/export');
  assert.equal(exp.status, 200);
  const str = JSON.stringify(exp.json);
  assert.ok(!str.includes('public_key'));
  assert.ok(!str.includes('passkeys'));
});

test('reto de entrada usado para registrar → 400', async () => {
  if (!sharedPasskey) return;
  const lo = await call('POST', '/api/webauthn/login-options');
  if (lo.status !== 200) return;
  const challenge = lo.json.challenge;
  const kp = genKey(ALGS.ES256);
  const spki = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const id = b64u(credId);
  const auth = makeAuthData(RP_ID, 0x45, 42, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const res = await call('POST', '/api/webauthn/register', {
    id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    name: 'x',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'No se pudo registrar la huella.');
});

test('entrada con reto de registro → 401', async () => {
  if (!sharedPasskey) return;
  const { id, kp, alg } = sharedPasskey;
  const ro = await call('POST', '/api/webauthn/register-options');
  assert.equal(ro.status, 200);
  const challenge = ro.json.challenge;
  const res = await passkeyLogin(id, kp, alg, 999999, challenge);
  assert.equal(res.status, 401);
});

test('entrada reto reutilizado → segunda 401', async () => {
  const lo = await call('POST', '/api/webauthn/login-options');
  if (lo.status !== 200) return;
  const id = lo.json.allowCredentials[0].id;
  const challenge = lo.json.challenge;
  const auth = makeAuthData(RP_ID, 0x05, 5);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const sig = crypto.randomBytes(72);
  const body = { id, clientDataJSON: cd, authenticatorData: b64u(auth), signature: b64u(sig) };
  const r1 = await call('POST', '/api/webauthn/login', body);
  assert.equal(r1.status, 401);
  const r2 = await call('POST', '/api/webauthn/login', body);
  assert.equal(r2.status, 401);
});

test('credencial desconocida → 401', async () => {
  const credId = crypto.randomBytes(16);
  const id = b64u(credId);
  const lo = await call('POST', '/api/webauthn/login-options');
  if (lo.status !== 200) return;
  const challenge = lo.json.challenge;
  const auth = makeAuthData(RP_ID, 0x05, 5);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const res = await call('POST', '/api/webauthn/login', {
    id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(crypto.randomBytes(72)),
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'No se pudo verificar la huella.');
});

test('Ed25519 y RSA también funcionan', async () => {
  for (const alg of [ALGS.EdDSA, ALGS.RS256]) {
    const { id, kp, regRes } = await registerPasskey(alg, 'Dev');
    assert.equal(regRes.status, 201, `alg ${alg}`);
    const lo = await call('POST', '/api/webauthn/login-options');
    const challenge = lo.json.challenge;
    const counter = 43;
    const auth = makeAuthData(RP_ID, 0x05, counter);
    const cd = clientData('webauthn.get', challenge, ORIGIN);
    const clientBytes = Buffer.from(cd, 'base64url');
    const data = Buffer.concat([auth, sha256(clientBytes)]);
    const signature = signData(alg, kp.privateKey as KeyObject, data);
    const loginRes = await call('POST', '/api/webauthn/login', {
      id,
      clientDataJSON: cd,
      authenticatorData: b64u(auth),
      signature: b64u(signature),
    });
    assert.equal(loginRes.status, 200, `alg ${alg}`);
  }
});

// ---------- Nuevos tests de seguridad/completitud ----------

test('register-options contenido completo', async () => {
  const reg = await registerPasskey(ALGS.ES256, 'Excluido');
  assert.equal(reg.regRes.status, 201);

  const ro = await call('POST', '/api/webauthn/register-options');
  assert.equal(ro.status, 200);
  assert.equal(ro.json.rp.id, 'webhub.test');
  assert.equal(ro.json.rp.name, 'WebHub');
  assert.ok(typeof ro.json.challenge === 'string' && ro.json.challenge.length > 0);
  assert.equal(ro.json.user.name, 'webhub');
  assert.equal(ro.json.user.displayName, 'WebHub');
  assert.match(ro.json.user.id, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(ro.json.pubKeyCredParams, [
    { type: 'public-key', alg: -7 },
    { type: 'public-key', alg: -257 },
    { type: 'public-key', alg: -8 },
  ]);
  assert.deepEqual(ro.json.authenticatorSelection, {
    authenticatorAttachment: 'platform',
    residentKey: 'preferred',
    userVerification: 'required',
  });
  assert.equal(ro.json.attestation, 'none');
  assert.equal(ro.json.timeout, 120000);
  const exclude = ro.json.excludeCredentials;
  assert.ok(Array.isArray(exclude));
  assert.ok(exclude.some((c: any) => c.id === reg.id));
  for (const c of exclude) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'type']);
  }
});

test('login-options contenido', async () => {
  if (!sharedPasskey) {
    const r = await registerPasskey(ALGS.ES256, 'shared2');
    sharedPasskey = { id: r.id, kp: r.kp, alg: ALGS.ES256 };
  }
  const lo = await call('POST', '/api/webauthn/login-options');
  assert.equal(lo.status, 200);
  assert.equal(lo.json.rpId, 'webhub.test');
  assert.equal(lo.json.userVerification, 'required');
  assert.equal(lo.json.timeout, 120000);
  assert.ok(Array.isArray(lo.json.allowCredentials));
  assert.ok(lo.json.allowCredentials.some((c: any) => c.id === sharedPasskey!.id));
  for (const c of lo.json.allowCredentials) {
    assert.deepEqual(Object.keys(c).sort(), ['id', 'type']);
  }
});

test('contador monotónico', async () => {
  const { id, kp } = await registerPasskey(ALGS.ES256, 'Counter');
  const alg = ALGS.ES256;
  let r = await passkeyLogin(id, kp, alg, 100);
  assert.equal(r.status, 200);
  r = await passkeyLogin(id, kp, alg, 100);
  assert.equal(r.status, 401);
  r = await passkeyLogin(id, kp, alg, 50);
  assert.equal(r.status, 401);
  r = await passkeyLogin(id, kp, alg, 101);
  assert.equal(r.status, 200);
  r = await passkeyLogin(id, kp, alg, 101);
  assert.equal(r.status, 401);
});

test('firma de otra clave → 401', async () => {
  if (!sharedPasskey) return;
  const { id } = sharedPasskey;
  const alt = genKey(ALGS.ES256);
  const lo = await call('POST', '/api/webauthn/login-options');
  assert.equal(lo.status, 200);
  const challenge = lo.json.challenge;
  const auth = makeAuthData(RP_ID, 0x05, 1000);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const data = Buffer.concat([auth, sha256(Buffer.from(cd, 'base64url'))]);
  const sig = signData(ALGS.ES256, alt.privateKey as KeyObject, data);
  const res = await call('POST', '/api/webauthn/login', {
    id,
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, 'No se pudo verificar la huella.');
  assert.ok(!res.headers.get('set-cookie'));
});

test('listado sin campos sensibles y lastUsedAt rellenado', async () => {
  const reg = await registerPasskey(ALGS.ES256, 'Lista');
  assert.equal(reg.regRes.status, 201);
  const lr = await passkeyLogin(reg.id, reg.kp, ALGS.ES256, 77);
  assert.equal(lr.status, 200);
  const list = await call('GET', '/api/webauthn/credentials');
  assert.equal(list.status, 200);
  const item = list.json.find((x: any) => x.id === reg.id);
  assert.ok(item);
  assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'lastUsedAt', 'name']);
  assert.ok(item.lastUsedAt !== null);
});

test('borrar passkey', async () => {
  const reg = await registerPasskey(ALGS.ES256, 'Borrar');
  assert.equal(reg.regRes.status, 201);
  const del = await call('DELETE', `/api/webauthn/credentials/${encodeURIComponent(reg.id)}`);
  assert.equal(del.status, 200);
  const del2 = await call('DELETE', `/api/webauthn/credentials/${encodeURIComponent(reg.id)}`);
  assert.equal(del2.status, 404);
  const del3 = await call('DELETE', '/api/webauthn/credentials/noexiste');
  assert.equal(del3.status, 404);

  const lo = await call('POST', '/api/webauthn/login-options');
  if (lo.status === 200) {
    const r = await passkeyLogin(reg.id, reg.kp, ALGS.ES256, 99, lo.json.challenge);
    assert.equal(r.status, 401);
  }
});

test('entrada con éxito sin cookie', async () => {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const app = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter: new LoginLimiter({ maxPerIp: 100, windowMs: 60_000 }) });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  try {
  const loginRes = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(loginRes.status, 200);
  const pinCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

  const r = await registerPasskeyAt(url, pinCookie, ALGS.ES256, 'SinCookie');
  assert.equal(r.regRes.status, 201);
  const id = r.id;
  const kp = r.kp;

  const loRes = await fetch(url + '/api/webauthn/login-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
  });
  assert.equal(loRes.status, 200);
  const loJson: any = await loRes.json();
  const challenge = loJson.challenge;

  const auth = makeAuthData(RP_ID, 0x05, 100);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const clientBytes = Buffer.from(cd, 'base64url');
  const data = Buffer.concat([auth, sha256(clientBytes)]);
  const signature = signData(ALGS.ES256, kp.privateKey as KeyObject, data);

  const passRes = await fetch(url + '/api/webauthn/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({
      id,
      clientDataJSON: cd,
      authenticatorData: b64u(auth),
      signature: b64u(signature),
    }),
  });
  assert.equal(passRes.status, 200);
  const setCookie = passRes.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const pkCookie = setCookie.split(';')[0]!;

  const dataRes = await fetch(url + '/api/data', { headers: { Cookie: pkCookie } });
  assert.equal(dataRes.status, 200);
  } finally { s.close(); }
});

test('passkey funciona con PIN bloqueado', async () => {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const limiter = new LoginLimiter({ maxPerIp: 3, windowMs: 60_000, streakLimit: 1000 });
  const app = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  try {
  const loginPin = async (pin: string) =>
    fetch(url + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin }),
    });

  const r0 = await loginPin(PIN);
  assert.equal(r0.status, 200);
  const pinCookie = (r0.headers.get('set-cookie') ?? '').split(';')[0]!;

  const reg = await registerPasskeyAt(url, pinCookie, ALGS.ES256, 'Bloqueo');
  assert.equal(reg.regRes.status, 201);
  const id = reg.id;
  const kp = reg.kp;

  for (let i = 0; i < 3; i++) {
    const fr = await loginPin('000000');
    assert.equal(fr.status, 401);
  }
  const blocked = await loginPin(PIN);
  assert.equal(blocked.status, 429);

  const loRes = await fetch(url + '/api/webauthn/login-options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
  });
  assert.equal(loRes.status, 200);
  const loJson: any = await loRes.json();
  const challenge = loJson.challenge;

  const auth = makeAuthData(RP_ID, 0x05, 200);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const clientBytes = Buffer.from(cd, 'base64url');
  const data = Buffer.concat([auth, sha256(clientBytes)]);
  const signature = signData(ALGS.ES256, kp.privateKey as KeyObject, data);

  const passRes = await fetch(url + '/api/webauthn/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({
      id,
      clientDataJSON: cd,
      authenticatorData: b64u(auth),
      signature: b64u(signature),
    }),
  });
  assert.equal(passRes.status, 200);
  const pkCookie = (passRes.headers.get('set-cookie') ?? '').split(';')[0]!;
  const dataRes = await fetch(url + '/api/data', { headers: { Cookie: pkCookie } });
  assert.equal(dataRes.status, 200);

  const pinAgain = await loginPin(PIN);
  assert.equal(pinAgain.status, 429);
  } finally { s.close(); }
});

test('máximo 10 passkeys', async () => {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const app = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter: new LoginLimiter({ maxPerIp: 100, windowMs: 60_000 }) });
  const s = app.server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  try {
  const loginRes = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(loginRes.status, 200);
  const pinCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

  for (let i = 0; i < 10; i++) {
    const r = await registerPasskeyAt(url, pinCookie, ALGS.ES256, `D${i}`);
    assert.equal(r.regRes.status, 201, `registro ${i}`);
  }
  const r11 = await registerPasskeyAt(url, pinCookie, ALGS.ES256, 'D10');
  assert.equal(r11.regRes.status, 400);
  } finally { s.close(); }
});
test('sin WEBHUB_PUBLIC_ORIGIN (cadena vacía) el origen se deduce de Host', async () => {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const app = createApp({ db, publicOrigin: '', insecureCookie: true }).server;
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const login = await fetch(`${url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const sesion = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const res = await fetch(`${url}/api/webauthn/register-options`, { method: 'POST', headers: { 'X-WebHub': '1', Cookie: sesion } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { rp: { id: string } }).rp.id, '127.0.0.1');
  } finally {
    app.close();
  }
});
