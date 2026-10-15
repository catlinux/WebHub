import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';
import { classify } from '../src/server/checker.ts';

const PIN = '20261015';
let server: Server;
let base = '';
let cookie = '';

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

async function waitCheck() {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', '/api/check');
    if (!r.json?.running) return;
    await new Promise((rsv) => setTimeout(rsv, 50));
  }
}

before(async () => {
  const db = openDatabase(null);
  await setPin(db, PIN);
  server = createApp({ db, insecureCookie: true }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call('POST', '/api/login', { pin: PIN });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
});

after(() => server.close());

test('classify: null y vacío → null', () => {
  assert.equal(classify(null), null);
  assert.equal(classify(''), null);
});

test('classify: ok para códigos < 400', () => {
  assert.equal(classify('200'), 'ok');
  assert.equal(classify('204'), 'ok');
  assert.equal(classify('301'), 'ok');
});

test('classify: protegido para 401 y 403', () => {
  assert.equal(classify('401'), 'protegido');
  assert.equal(classify('403'), 'protegido');
});

test('classify: privado para 404/410 de GitHub exacto', () => {
  assert.equal(classify('404', 'https://github.com/usuario/repo'), 'privado');
  assert.equal(classify('410', 'https://github.com/usuario/repo'), 'privado');
  assert.equal(classify('404', 'https://www.github.com/x/y'), 'privado');
});

test('classify: hosts engañosos y urls inválidas → roto', () => {
  for (const u of ['https://evilgithub.com/x', 'https://github.com.evil.com/x', 'https://gist.github.com/x', 'no es una url']) {
    assert.equal(classify('404', u), 'roto', u);
  }
  assert.equal(classify('404', undefined), 'roto');
});

test('classify: aviso para 429, 5xx y tiempo agotado', () => {
  assert.equal(classify('429'), 'aviso');
  assert.equal(classify('500'), 'aviso');
  assert.equal(classify('503'), 'aviso');
  assert.equal(classify('tiempo agotado'), 'aviso');
});

test('classify: roto para otros 4xx y errores de red', () => {
  assert.equal(classify('400'), 'roto');
  assert.equal(classify('405'), 'roto');
  assert.equal(classify('451'), 'roto');
  assert.equal(classify('dominio no encontrado'), 'roto');
  assert.equal(classify('conexión rechazada'), 'roto');
});

test('classify: ignored con prioridad sobre privado y protegido', () => {
  assert.equal(classify('404', 'https://github.com/x/y', true), 'ignorado');
  assert.equal(classify('403', undefined, true), 'ignorado');
  assert.equal(classify('200', undefined, true), 'ignorado');
  // null/vacío siguen siendo null aunque esté ignorado
  assert.equal(classify(null, undefined, true), null);
  assert.equal(classify('', undefined, true), null);
});

test('un enlace nuevo tiene checkIgnored false', async () => {
  const fam = (await call('POST', '/api/families', { name: 'F' })).json;
  const link = (await call('POST', '/api/links', { familyId: fam.id, url: 'ejemplo.com', title: 'x' })).json;
  assert.equal(link.checkIgnored, false);
  const data = (await call('GET', '/api/data')).json;
  const l = data.links.find((x: any) => x.id === link.id);
  assert.equal(l.checkIgnored, false);
});

test('PATCH /api/links/:id guarda checkIgnored y /api/data lo refleja', async () => {
  const fam = (await call('POST', '/api/families', { name: 'F2' })).json;
  const link = (await call('POST', '/api/links', { familyId: fam.id, url: 'ejemplo2.com', title: 'x' })).json;
  const p = await call('PATCH', `/api/links/${link.id}`, { checkIgnored: true });
  assert.equal(p.status, 200);
  assert.equal(p.json.checkIgnored, true);
  const data = (await call('GET', '/api/data')).json;
  const l = data.links.find((x: any) => x.id === link.id);
  assert.equal(l.checkIgnored, true);

  const p2 = await call('PATCH', `/api/links/${link.id}`, { checkIgnored: false });
  assert.equal(p2.status, 200);
  assert.equal(p2.json.checkIgnored, false);
});

test('PATCH con checkIgnored no booleano → 400 y no cambia', async () => {
  const fam = (await call('POST', '/api/families', { name: 'F3' })).json;
  const link = (await call('POST', '/api/links', { familyId: fam.id, url: 'ejemplo3.com', title: 'x' })).json;
  await call('PATCH', `/api/links/${link.id}`, { checkIgnored: true });
  for (const bad of ['si', 1, null]) {
    const r = await call('PATCH', `/api/links/${link.id}`, { checkIgnored: bad });
    assert.equal(r.status, 400, String(bad));
  }
  const data = (await call('GET', '/api/data')).json;
  const l = data.links.find((x: any) => x.id === link.id);
  assert.equal(l.checkIgnored, true);
});

test('PATCH de otro campo conserva la marca', async () => {
  const fam = (await call('POST', '/api/families', { name: 'F4' })).json;
  const link = (await call('POST', '/api/links', { familyId: fam.id, url: 'ejemplo4.com', title: 'orig' })).json;
  await call('PATCH', `/api/links/${link.id}`, { checkIgnored: true });
  const p = await call('PATCH', `/api/links/${link.id}`, { title: 'nuevo' });
  assert.equal(p.status, 200);
  assert.equal(p.json.title, 'nuevo');
  assert.equal(p.json.checkIgnored, true);
  const data = (await call('GET', '/api/data')).json;
  const l = data.links.find((x: any) => x.id === link.id);
  assert.equal(l.checkIgnored, true);
});

test('cambiar la URL conserva la marca y limpia check_status', async () => {
  const fam = (await call('POST', '/api/families', { name: 'F5' })).json;
  const link = (await call('POST', '/api/links', { familyId: fam.id, url: 'ejemplo5.com', title: 'x' })).json;
  await call('PATCH', `/api/links/${link.id}`, { checkIgnored: true });
  await call('POST', '/api/check');
  await waitCheck();
  const before = (await call('GET', '/api/data')).json.links.find((x: any) => x.id === link.id);
  // check_status puede haberse rellenado
  const p = await call('PATCH', `/api/links/${link.id}`, { url: 'ejemplo6.com' });
  assert.equal(p.status, 200);
  assert.equal(p.json.checkIgnored, true);
  // check_status y checked_at deben quedar null tras el cambio de URL
  const after = (await call('GET', '/api/data')).json.links.find((x: any) => x.id === link.id);
  assert.equal(after.checkStatus, null);
  assert.equal(after.checkedAt, null);
  assert.equal(after.checkIgnored, true);
  void before;
});

test('export incluye checkIgnored y restaurar copia lo conserva; copia antigua → false; formato 1', async () => {
  const fam = (await call('POST', '/api/families', { name: 'Fexp' })).json;
  const link = (await call('POST', '/api/links', { familyId: fam.id, url: 'exp.com', title: 'x' })).json;
  await call('PATCH', `/api/links/${link.id}`, { checkIgnored: true });

  const exp = await call('GET', '/api/export');
  assert.equal(exp.json.formato, 1);
  const exLink = exp.json.links.find((l: any) => l.id === link.id);
  assert.equal(exLink.checkIgnored, true);

  const ok = await call('POST', '/api/import/json', { data: exp.json, confirm: 'SUSTITUIR' });
  assert.equal(ok.status, 200);
  const after = (await call('GET', '/api/data')).json;
  // tras restaurar, algún enlace conserva checkIgnored true
  assert.ok(after.links.some((l: any) => l.checkIgnored === true));

  const old = structuredClone(exp.json);
  for (const l of old.links) delete l.checkIgnored;
  const ok2 = await call('POST', '/api/import/json', { data: old, confirm: 'SUSTITUIR' });
  assert.equal(ok2.status, 200);
  const after2 = (await call('GET', '/api/data')).json;
  assert.ok(after2.links.every((l: any) => l.checkIgnored === false));
});