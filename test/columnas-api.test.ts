import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';

const PIN = '20261015';
let server: any;
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

async function rawCall(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
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

test('una familia nueva tiene col null en /api/data', async () => {
  const r = await call('POST', '/api/families', { name: 'NuevaCol' });
  assert.equal(r.status, 201);
  assert.equal(r.json.col, null);
  const data = (await call('GET', '/api/data')).json;
  const f = data.families.find((x: any) => x.id === r.json.id);
  assert.equal(f.col, null);
});

test('PUT /api/families/layout guarda position y col y devuelve ok', async () => {
  const a = (await call('POST', '/api/families', { name: 'A' })).json;
  const b = (await call('POST', '/api/families', { name: 'B' })).json;
  const parent = (await call('POST', '/api/families', { name: 'Padre' })).json;
  const child = (await call('POST', '/api/families', { name: 'Hija', parentId: parent.id })).json;
  const beforeChild = (await call('GET', '/api/data')).json.families.find((x: any) => x.id === child.id);

  const dataBefore = (await call('GET', '/api/data')).json;
  const allPrincipals = (dataBefore.families as any[]).filter((f) => f.parentId === null).map((f) => f.id);
  const items = [
    { id: b.id, col: 3 },
    { id: a.id, col: 7 },
    { id: parent.id, col: 0 },
    ...allPrincipals
      .filter((id) => id !== b.id && id !== a.id && id !== parent.id)
      .map((id) => ({ id, col: 1 })),
  ];
  const r = await call('PUT', '/api/families/layout', { items });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });

  const data = (await call('GET', '/api/data')).json;
  const principal = (id: number) => data.families.find((x: any) => x.id === id);
  assert.equal(principal(b.id).position, 0);
  assert.equal(principal(b.id).col, 3);
  assert.equal(principal(a.id).position, 1);
  assert.equal(principal(a.id).col, 7);
  assert.equal(principal(parent.id).position, 2);
  assert.equal(principal(parent.id).col, 0);

  const afterChild = data.families.find((x: any) => x.id === child.id);
  assert.equal(afterChild.position, beforeChild.position);
  assert.equal(afterChild.col, beforeChild.col);
});

test('rechazos con 400 y sin cambiar datos', async () => {
  const before = structuredClone((await call('GET', '/api/data')).json);
  const families = before.families as any[];
  const principals = families.filter((f: any) => f.parentId === null);
  const principalIds = principals.map((f: any) => f.id);
  const sub = families.find((f: any) => f.parentId !== null);

  async function expect400(body: any) {
    const r = await call('PUT', '/api/families/layout', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const after = (await call('GET', '/api/data')).json;
    assert.deepEqual(after, before);
  }

  // falta un id
  await expect400({ items: principalIds.slice(1).map((id) => ({ id, col: 0 })) });
  // sobra id desconocido
  await expect400({ items: [...principalIds.map((id) => ({ id, col: 0 })), { id: 999999, col: 0 }] });
  // id repetido
  if (principalIds.length > 0) {
    const dup = principalIds[0];
    await expect400({ items: [{ id: dup, col: 0 }, ...principalIds.map((id) => ({ id, col: 0 }))] });
  }
  // incluye subfamilia
  if (sub) await expect400({ items: [...principalIds.map((id) => ({ id, col: 0 })), { id: sub.id, col: 0 }] });
  // items no es array
  await expect400({ items: 'no' });
  // body sin items
  await expect400({});
  // items vacío existiendo familias
  await expect400({ items: [] });
  // id no entero
  for (const bad of ['1', 1.5, null]) {
    const payload = principalIds.length ? [{ id: bad, col: 0 }] : [{ id: bad, col: 0 }];
    await expect400({ items: principalIds.length ? [{ id: bad, col: 0 }, ...principalIds.slice(1).map((id) => ({ id, col: 0 }))] : [{ id: bad, col: 0 }] });
  }
  // col inválidos
  if (principalIds.length > 0) {
    const baseItems = principalIds.map((id) => ({ id, col: 0 }));
    for (const badCol of [12, -1, 2.5, '1', null]) {
      const items = baseItems.map((x, i) => (i === 0 ? { ...x, col: badCol } : x));
      await expect400({ items });
    }
    const noCol = baseItems.map((x, i) => (i === 0 ? { id: x.id } : x));
    await expect400({ items: noCol });
  }
});

test('sin sesión → 401', async () => {
  const r = await rawCall('PUT', '/api/families/layout', { items: [] }, { 'X-WebHub': '1' });
  assert.equal(r.status, 401);
});

test('sin X-WebHub → 403', async () => {
  const r = await rawCall('PUT', '/api/families/layout', { items: [] }, { Cookie: cookie });
  assert.equal(r.status, 403);
});

test('Origin ajeno → 403', async () => {
  const r = await rawCall('PUT', '/api/families/layout', { items: [] }, { Cookie: cookie, 'X-WebHub': '1', Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('atomicidad: inválido al final no aplica parciales', async () => {
  const before = structuredClone((await call('GET', '/api/data')).json);
  const families = before.families as any[];
  const principals = families.filter((f: any) => f.parentId === null);
  const principalIds = principals.map((f: any) => f.id);
  if (principalIds.length === 0) return;
  const items = principalIds.map((id, i) => ({ id, col: (i === principalIds.length - 1) ? 12 : 5 }));
  const r = await call('PUT', '/api/families/layout', { items });
  assert.equal(r.status, 400);
  const after = (await call('GET', '/api/data')).json;
  assert.deepEqual(after, before);
});

test('PATCH { col: 5 } NO cambia col; PATCH nombre conserva col', async () => {
  // find a principal with a col set
  let data = (await call('GET', '/api/data')).json;
  let fam = data.families.find((f: any) => f.parentId === null);
  // set layout to give it col 5
  const principals = data.families.filter((f: any) => f.parentId === null).map((f: any) => f.id);
  const items = principals.map((id: number, i: number) => ({ id, col: id === fam.id ? 5 : 1 }));
  await call('PUT', '/api/families/layout', { items });
  data = (await call('GET', '/api/data')).json;
  fam = data.families.find((f: any) => f.id === fam.id);
  assert.equal(fam.col, 5);

  const p = await call('PATCH', `/api/families/${fam.id}`, { col: 999 });
  assert.equal(p.status, 200);
  assert.equal(p.json.col, 5);

  const p2 = await call('PATCH', `/api/families/${fam.id}`, { name: fam.name + '2' });
  assert.equal(p2.status, 200);
  assert.equal(p2.json.name, fam.name + '2');
  assert.equal(p2.json.col, 5);
  const after = (await call('GET', '/api/data')).json.families.find((f: any) => f.id === fam.id);
  assert.equal(after.col, 5);
});

test('export incluye col, restaurar conserva; copia antigua → null; fuera de rango/subfamilia → null; formato 1', async () => {
  const exp = await call('GET', '/api/export');
  assert.equal(exp.json.formato, 1);
  assert.ok(exp.json.families.some((f: any) => Object.prototype.hasOwnProperty.call(f, 'col')));

  const dump = exp.json;
  const ok = await call('POST', '/api/import/json', { data: dump, confirm: 'SUSTITUIR' });
  assert.equal(ok.status, 200);
  const after = (await call('GET', '/api/data')).json;
  // at least one principal col preserved if present
  const beforeCols = dump.families.map((f: any) => f.col);
  const afterCols = after.families.map((f: any) => f.col);
  // same sequence lengths
  assert.equal(afterCols.length, beforeCols.length);

  // old copy without col → null
  const old = structuredClone(dump);
  for (const f of old.families) delete f.col;
  const ok2 = await call('POST', '/api/import/json', { data: old, confirm: 'SUSTITUIR' });
  assert.equal(ok2.status, 200);
  const after2 = (await call('GET', '/api/data')).json;
  assert.ok(after2.families.every((f: any) => f.col === null));

  // out of range / subfamily → null
  const crafted = structuredClone(dump);
  for (const f of crafted.families) {
    if (f.parentId === null) f.col = 99;
    else f.col = 2;
  }
  const ok3 = await call('POST', '/api/import/json', { data: crafted, confirm: 'SUSTITUIR' });
  assert.equal(ok3.status, 200);
  const after3 = (await call('GET', '/api/data')).json;
  assert.ok(after3.families.every((f: any) => f.col === null));
});

test('PUT con items [] y sin familias → 200', async () => {
  // delete all families first
  const data = (await call('GET', '/api/data')).json;
  for (const f of data.families.filter((x: any) => x.parentId === null)) {
    await call('DELETE', `/api/families/${f.id}`);
  }
  const r = await call('PUT', '/api/families/layout', { items: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
});

test('restaurar una copia recupera exactamente la columna y el orden de cada familia principal', async () => {
  for (const n of ['Rest1', 'Rest2', 'Rest3']) await call('POST', '/api/families', { name: n });
  const principales = (await call('GET', '/api/data')).json.families.filter((f: any) => f.parentId === null);
  const colDe = (i: number) => (i * 5) % 12;
  const items = principales.map((f: any, i: number) => ({ id: f.id, col: colDe(i) }));
  assert.equal((await call('PUT', '/api/families/layout', { items })).status, 200);
  const esperado = (await call('GET', '/api/data')).json.families.filter((f: any) => f.parentId === null).map((f: any) => [f.name, f.col]);
  assert.ok(esperado.some(([, c]: any) => c !== null && c > 0), 'hay columnas distintas de 0');
  const dump = (await call('GET', '/api/export')).json;
  assert.equal((await call('POST', '/api/import/json', { data: dump, confirm: 'SUSTITUIR' })).status, 200);
  const despues = (await call('GET', '/api/data')).json.families.filter((f: any) => f.parentId === null).map((f: any) => [f.name, f.col]);
  assert.deepEqual(despues, esperado);
});
