import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';
import { ASPECTO_INICIAL } from '../src/shared/aspecto.ts';

const PIN = '20261015';
const ORIGIN = 'https://webhub.test';

let server: Server;
let base = '';
let cookie = '';
let db: any;

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
  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  db = openDatabase(null);
  await setPin(db, PIN);
  server = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN }).server;
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

after(() => server.close());

test('sin sesión → 401', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await call('GET', '/api/aspecto')).status, 401);
  assert.equal((await call('PUT', '/api/aspecto', { tema: 'claro' })).status, 401);
  cookie = saved;
});

test('GET sin guardado devuelve ASPECTO_INICIAL', async () => {
  const r = await call('GET', '/api/aspecto');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, ASPECTO_INICIAL);
});

test('PUT guarda y GET posterior devuelve lo mismo', async () => {
  const body = { tema: 'claro', texto: 150, tituloColor: '#112233', acento: null };
  const p = await call('PUT', '/api/aspecto', body);
  assert.equal(p.status, 200);
  const g = await call('GET', '/api/aspecto');
  assert.equal(g.status, 200);
  assert.equal(g.json.tema, 'claro');
  assert.equal(g.json.texto, 150);
  assert.equal(g.json.tituloColor, '#112233');
  assert.equal(g.json.acento, null);
});

test('PUT inválido devuelve iniciales y no guarda inválidos', async () => {
  const body = { tema: 'x', texto: 'grande', color: 'red;background:url(//x)', tituloPeso: 500 };
  const p = await call('PUT', '/api/aspecto', body);
  assert.equal(p.status, 200);
  assert.equal(p.json.tema, ASPECTO_INICIAL.tema);
  assert.equal(p.json.texto, ASPECTO_INICIAL.texto);
  assert.equal(p.json.color, ASPECTO_INICIAL.color);
  assert.equal(p.json.tituloPeso, ASPECTO_INICIAL.tituloPeso);
  const g = await call('GET', '/api/aspecto');
  assert.equal(g.json.tema, ASPECTO_INICIAL.tema);
  assert.equal(g.json.texto, ASPECTO_INICIAL.texto);
});

test('PUT con campos desconocidos no se guardan', async () => {
  const p = await call('PUT', '/api/aspecto', { foo: 'bar', unknown: 1, tema: 'claro' });
  assert.equal(p.status, 200);
  assert.ok(!('foo' in p.json));
  assert.ok(!('unknown' in p.json));
  const g = await call('GET', '/api/aspecto');
  assert.ok(!('foo' in g.json));
  assert.ok(!('unknown' in g.json));
});

test('PUT array/null/cuerpo grande → 400/413 y no cambia', async () => {
  // set a known value
  await call('PUT', '/api/aspecto', { tema: 'claro' });
  const before = (await call('GET', '/api/aspecto')).json;

  // array
  const r1 = await fetch(base + '/api/aspecto', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookie },
    body: JSON.stringify([1, 2, 3]),
  });
  assert.ok(r1.status === 400 || r1.status === 413);

  // null
  const r2 = await fetch(base + '/api/aspecto', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookie },
    body: 'null',
  });
  assert.ok(r2.status === 400 || r2.status === 413);

  // grande
  const big = JSON.stringify({ tema: 'claro', x: 'a'.repeat(5000) });
  const r3 = await fetch(base + '/api/aspecto', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Cookie: cookie },
    body: big,
  });
  assert.ok(r3.status === 400 || r3.status === 413);

  const after = (await call('GET', '/api/aspecto')).json;
  assert.deepEqual(after, before);
});

test('PUT sin X-WebHub → 403', async () => {
  const res = await fetch(base + '/api/aspecto', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ tema: 'claro' }),
  });
  assert.equal(res.status, 403);
});

test('PUT con Origin ajeno → 403', async () => {
  const res = await fetch(base + '/api/aspecto', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Origin: 'https://other.test', Cookie: cookie },
    body: JSON.stringify({ tema: 'claro' }),
  });
  assert.equal(res.status, 403);
});

test('valor en settings es JSON saneado y sin inyección', async () => {
  await call('PUT', '/api/aspecto', { tituloColor: 'red;background:url(//x)', tema: 'claro' });
  const row: any = db.prepare("SELECT value FROM settings WHERE key = 'aspecto'").get();
  assert.ok(row);
  const parsed = JSON.parse(row.value);
  assert.equal(parsed.tituloColor, null);
  assert.equal(parsed.tema, 'claro');
  assert.ok(!row.value.includes('background:url'));
  // no unknown extra keys beyond Aspecto
  assert.deepEqual(Object.keys(parsed).sort(), [
    'acento', 'color', 'densidad', 'fondo', 'fuente', 'intensidad',
    'mostrarDominio', 'tema', 'texto', 'tituloColor', 'tituloMayusculas',
    'tituloPeso', 'tituloTamano',
  ].sort());
});

test('/api/export no contiene aspecto', async () => {
  const r = await call('GET', '/api/export');
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.json).includes('aspecto'));
});

test('GET sanea lo que haya en la base aunque se escribiera sin pasar por PUT', async () => {
  const sucio = JSON.stringify({ tema: 'claro', acento: 'red;background:url(//x)', texto: 9999, extra: 'x' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('aspecto', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(sucio);
  const r = await call('GET', '/api/aspecto');
  assert.equal(r.status, 200);
  assert.equal(r.json.tema, 'claro');
  assert.equal(r.json.acento, null);
  assert.equal(r.json.texto, 200);
  assert.equal('extra' in r.json, false);
});
