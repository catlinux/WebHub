import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';

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

test('una familia nueva aparece con collapsed false', async () => {
  const r = await call('POST', '/api/families', { name: 'Nueva' });
  assert.equal(r.status, 201);
  assert.equal(r.json.collapsed, false);
  const data = (await call('GET', '/api/data')).json;
  const f = data.families.find((x: any) => x.id === r.json.id);
  assert.equal(f.collapsed, false);
});

test('crear con collapsed true', async () => {
  const r = await call('POST', '/api/families', { name: 'Plegada', collapsed: true });
  assert.equal(r.status, 201);
  assert.equal(r.json.collapsed, true);
  const data = (await call('GET', '/api/data')).json;
  const f = data.families.find((x: any) => x.id === r.json.id);
  assert.equal(f.collapsed, true);
});

test('PATCH cambia collapsed y PATCH de solo nombre no lo cambia', async () => {
  const r = await call('POST', '/api/families', { name: 'X', collapsed: true });
  const id = r.json.id;
  const p = await call('PATCH', `/api/families/${id}`, { collapsed: false });
  assert.equal(p.status, 200);
  assert.equal(p.json.collapsed, false);
  const p2 = await call('PATCH', `/api/families/${id}`, { name: 'X2' });
  assert.equal(p2.status, 200);
  assert.equal(p2.json.name, 'X2');
  assert.equal(p2.json.collapsed, false);
});

test('valor no booleano en POST y PATCH → 400 y no cambia nada', async () => {
  const before = (await call('GET', '/api/data')).json.families.length;
  for (const bad of ['si', 1, null]) {
    const r = await call('POST', '/api/families', { name: 'Bad', collapsed: bad });
    assert.equal(r.status, 400, String(bad));
  }
  const after = (await call('GET', '/api/data')).json.families.length;
  assert.equal(after, before);

  const fam = (await call('POST', '/api/families', { name: 'Keep', collapsed: true })).json;
  for (const bad of ['si', 1, null]) {
    const r = await call('PATCH', `/api/families/${fam.id}`, { collapsed: bad });
    assert.equal(r.status, 400, String(bad));
  }
  const data = (await call('GET', '/api/data')).json;
  const f = data.families.find((x: any) => x.id === fam.id);
  assert.equal(f.collapsed, true);
  assert.equal(f.name, 'Keep');
});

test('las subfamilias también admiten collapsed', async () => {
  const parent = (await call('POST', '/api/families', { name: 'Padre' })).json;
  const child = await call('POST', '/api/families', { name: 'Hija', parentId: parent.id, collapsed: true });
  assert.equal(child.status, 201);
  assert.equal(child.json.collapsed, true);
  const data = (await call('GET', '/api/data')).json;
  const f = data.families.find((x: any) => x.id === child.json.id);
  assert.equal(f.parentId, parent.id);
  assert.equal(f.collapsed, true);
});

test('export incluye collapsed y restaurar copia lo conserva; copia antigua queda false; formato 1', async () => {
  await call('POST', '/api/families', { name: 'ExportCol', collapsed: true });
  const exp = await call('GET', '/api/export');
  assert.equal(exp.json.formato, 1);
  assert.ok(exp.json.families.some((f: any) => f.collapsed === true));

  const dump = exp.json;
  const ok = await call('POST', '/api/import/json', { data: dump, confirm: 'SUSTITUIR' });
  assert.equal(ok.status, 200);
  const after = (await call('GET', '/api/data')).json;
  assert.ok(after.families.some((f: any) => f.collapsed === true));

  const old = structuredClone(dump);
  for (const f of old.families) delete f.collapsed;
  const ok2 = await call('POST', '/api/import/json', { data: old, confirm: 'SUSTITUIR' });
  assert.equal(ok2.status, 200);
  const after2 = (await call('GET', '/api/data')).json;
  assert.ok(after2.families.every((f: any) => f.collapsed === false));
});
test('PATCH de solo el nombre conserva collapsed true', async () => {
  const id = (await call('POST', '/api/families', { name: 'Conserva', collapsed: true })).json.id;
  const p = await call('PATCH', `/api/families/${id}`, { name: 'Conserva 2' });
  assert.equal(p.json.name, 'Conserva 2');
  assert.equal(p.json.collapsed, true);
  assert.equal((await call('GET', '/api/data')).json.families.find((f: { id: number }) => f.id === id).collapsed, true);
});
