import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';
import { ApiError } from '../src/client/api.ts';
import { ReintentoDialogo } from '../src/client/dialogs.ts';

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

test('cliente: ApiError conserva data y ReintentoDialogo propiedades', () => {
  const err = new ApiError(409, 'msg', { existente: { id: 1 } });
  assert.equal(err.status, 409);
  assert.equal(err.message, 'msg');
  assert.deepEqual(err.data, { existente: { id: 1 } });
  const r = new ReintentoDialogo('m', 'btn');
  assert.equal(r.mensaje, 'm');
  assert.equal(r.etiquetaBoton, 'btn');
  assert.equal(r.message, 'm');
});

test('sin sesión → 401 en POST y PATCH', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await call('POST', '/api/links', { familyId: 1, url: 'https://a.example/' })).status, 401);
  assert.equal((await call('PATCH', '/api/links/1', { title: 'x' })).status, 401);
  cookie = saved;
});

test('duplicado básico: 409 con error y existente', async () => {
  const fam = (await call('POST', '/api/families', { name: 'FamDup' })).json;
  const first = await call('POST', '/api/links', { familyId: fam.id, url: 'https://example.com/recurso?b=2&a=1', title: 'Primero' });
  assert.equal(first.status, 201);
  const second = await call('POST', '/api/links', { familyId: fam.id, url: 'https://example.com/recurso?b=2&a=1', title: 'Segundo' });
  assert.equal(second.status, 409);
  assert.equal(second.headers.get('content-type')?.includes('application/json'), true);
  assert.match(second.json.error, /Ya tienes este enlace/);
  assert.deepEqual(Object.keys(second.json).sort(), ['error', 'existente']);
  assert.deepEqual(Object.keys(second.json.existente).sort(), ['familia', 'familyId', 'id', 'title']);
  assert.equal(second.json.existente.id, first.json.id);
  assert.equal(second.json.existente.title, 'Primero');
  assert.equal(second.json.existente.familyId, fam.id);
  assert.equal(second.json.existente.familia, 'FamDup');
  // no crea nada
  const before = (await call('GET', '/api/data')).json.links.length;
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://example.com/recurso?b=2&a=1' });
  const after = (await call('GET', '/api/data')).json.links.length;
  assert.equal(after, before);
});

test('variantes que son la misma URL → 409', async () => {
  const fam = (await call('POST', '/api/families', { name: 'Var' })).json;
  const base = 'https://ExampleVar.com/recurso/?b=2&a=1#frag';
  const first = await call('POST', '/api/links', { familyId: fam.id, url: base, title: 'Base' });
  assert.equal(first.status, 201);
  const variants = [
    'https://www.examplevar.com/recurso/?a=1&b=2#x',
    'https://examplevar.com/recurso?a=1&b=2',
    'https://EXAMPLEVAR.com/recurso/?b=2&a=1',
    'http://examplevar.com/recurso/?a=1&b=2',
  ];
  for (const v of variants) {
    const r = await call('POST', '/api/links', { familyId: fam.id, url: v });
    assert.equal(r.status, 409, v);
  }
});

test('URL distinta → 201', async () => {
  const fam = (await call('POST', '/api/families', { name: 'Dist' })).json;
  const first = await call('POST', '/api/links', { familyId: fam.id, url: 'https://example.com/a?x=1', title: 'A' });
  assert.equal(first.status, 201);
  const second = await call('POST', '/api/links', { familyId: fam.id, url: 'https://example.com/b?x=1', title: 'B' });
  assert.equal(second.status, 201);
  const third = await call('POST', '/api/links', { familyId: fam.id, url: 'https://example.com/a?x=2', title: 'C' });
  assert.equal(third.status, 201);
});

test('permitirDuplicado: true → 201 y quedan dos', async () => {
  const fam = (await call('POST', '/api/families', { name: 'Perm' })).json;
  const first = await call('POST', '/api/links', { familyId: fam.id, url: 'https://perm.example/x', title: 'P1' });
  assert.equal(first.status, 201);
  const second = await call('POST', '/api/links', { familyId: fam.id, url: 'https://perm.example/x', title: 'P2', permitirDuplicado: true });
  assert.equal(second.status, 201);
  const data = (await call('GET', '/api/data')).json;
  const count = data.links.filter((l: any) => l.url === first.json.url).length;
  assert.ok(count >= 2);
});

test('permitirDuplicado con valores no booleanos → 409', async () => {
  const fam = (await call('POST', '/api/families', { name: 'NonBool' })).json;
  const first = await call('POST', '/api/links', { familyId: fam.id, url: 'https://nonbool.example/x', title: 'N1' });
  assert.equal(first.status, 201);
  for (const val of ['true', 1, 'si']) {
    const r = await call('POST', '/api/links', { familyId: fam.id, url: 'https://nonbool.example/x', title: 'NX', permitirDuplicado: val });
    assert.equal(r.status, 409, String(val));
  }
});

test('familia en existente es Padre › Hijo para subfamilia', async () => {
  const parent = (await call('POST', '/api/families', { name: 'Padre' })).json;
  const child = (await call('POST', '/api/families', { name: 'Hijo', parentId: parent.id })).json;
  const first = await call('POST', '/api/links', { familyId: child.id, url: 'https://subfam.example/x', title: 'Sub' });
  assert.equal(first.status, 201);
  const second = await call('POST', '/api/links', { familyId: child.id, url: 'https://subfam.example/x' });
  assert.equal(second.status, 409);
  assert.equal(second.json.existente.familia, 'Padre › Hijo');
});

test('varios duplicados previos → el de menor id', async () => {
  const fam = (await call('POST', '/api/families', { name: 'MultiDup' })).json;
  const first = await call('POST', '/api/links', { familyId: fam.id, url: 'https://multidup.example/x', title: 'M1', permitirDuplicado: true });
  // create first as normal (already done)
  let firstId = first.json.id;
  // ensure three duplicates
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://multidup.example/x', title: 'M2', permitirDuplicado: true });
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://multidup.example/x', title: 'M3', permitirDuplicado: true });
  // first created without permit? Actually first request normal created one; subsequent permit created extras.
  const last = await call('POST', '/api/links', { familyId: fam.id, url: 'https://multidup.example/x', title: 'M4' });
  assert.equal(last.status, 409);
  assert.equal(last.json.existente.id, firstId);
});

test('PATCH URL a la de OTRO enlace → 409 y no cambia nada', async () => {
  const fam = (await call('POST', '/api/families', { name: 'PatchDup' })).json;
  const a = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchdup.example/a', title: 'A' })).json;
  const b = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchdup.example/b', title: 'B' })).json;
  const before = (await call('GET', '/api/data')).json.links.find((l: any) => l.id === b.id);
  const r = await call('PATCH', `/api/links/${b.id}`, { url: 'https://patchdup.example/a' });
  assert.equal(r.status, 409);
  const after = (await call('GET', '/api/data')).json.links.find((l: any) => l.id === b.id);
  assert.equal(after.url, before.url);
  assert.equal(after.title, before.title);
});

test('PATCH a URL libre → 200', async () => {
  const fam = (await call('POST', '/api/families', { name: 'PatchFree' })).json;
  const a = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchfree.example/a', title: 'A' })).json;
  const r = await call('PATCH', `/api/links/${a.id}`, { url: 'https://patchfree.example/c' });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, 'https://patchfree.example/c');
});

test('PATCH solo título → 200 aunque existan duplicados', async () => {
  const fam = (await call('POST', '/api/families', { name: 'PatchTitle' })).json;
  const a = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchtitle.example/x', title: 'A', permitirDuplicado: true })).json;
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchtitle.example/x', title: 'B', permitirDuplicado: true });
  const r = await call('PATCH', `/api/links/${a.id}`, { title: 'A2' });
  assert.equal(r.status, 200);
  assert.equal(r.json.title, 'A2');
});

test('PATCH reescribe la misma URL equivalente (barra final) sobre sí mismo → 200', async () => {
  const fam = (await call('POST', '/api/families', { name: 'PatchEquiv' })).json;
  const a = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchequiv.example/ruta/', title: 'A' })).json;
  const r = await call('PATCH', `/api/links/${a.id}`, { url: 'https://patchequiv.example/ruta' });
  assert.equal(r.status, 200);
});

test('PATCH con permitirDuplicado true → 200', async () => {
  const fam = (await call('POST', '/api/families', { name: 'PatchPerm' })).json;
  const a = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchperm.example/a', title: 'A' })).json;
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchperm.example/b', title: 'B' });
  // b becomes duplicate of a's url only if changed; set b url to a url with permit
  const b = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchperm.example/b2', title: 'B2' })).json;
  const r = await call('PATCH', `/api/links/${b.id}`, { url: 'https://patchperm.example/a', permitirDuplicado: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, 'https://patchperm.example/a');
  // cleanup unused
  void a;
});

test('importación de marcadores con skipDuplicates false crea duplicados', async () => {
  const fam = (await call('POST', '/api/families', { name: 'ImpFam' })).json;
  // create one existing link matching fixture url shape
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://www.ejemplo-import.test/x', title: 'EXIST' });
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
  <DT><H3>ImpFam</H3>
  <DL><p><DT><A HREF="https://www.ejemplo-import.test/x/">Dup importado</A></DL><p>
</DL>`;
  const before = (await call('GET', '/api/data')).json.links.length;
  const res = await call('POST', '/api/import/bookmarks/confirm', { html, skipDuplicates: false });
  assert.equal(res.status, 200);
  assert.ok(res.json.links >= 1, 'crea al menos uno');
  const after = (await call('GET', '/api/data')).json.links.length;
  assert.equal(after - before, res.json.links);
});

test('importJson restaura todos los duplicados', async () => {
  // create duplicates
  const fam = (await call('POST', '/api/families', { name: 'JsonDup' })).json;
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://jsondup.example/x', title: 'J1' });
  await call('POST', '/api/links', { familyId: fam.id, url: 'https://jsondup.example/x', title: 'J2', permitirDuplicado: true });
  const exp = await call('GET', '/api/export');
  const dump = exp.json;
  const beforeCount = (await call('GET', '/api/data')).json.links.length;
  const r = await call('POST', '/api/import/json', { data: dump, confirm: 'SUSTITUIR' });
  assert.equal(r.status, 200);
  const afterCount = (await call('GET', '/api/data')).json.links.length;
  assert.equal(afterCount, beforeCount);
});
test('PATCH con permitirDuplicado que no es booleano estricto sigue dando 409 y no cambia nada', async () => {
  const fam = (await call('POST', '/api/families', { name: 'PatchNoBool' })).json;
  const a = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchnobool.example/a', title: 'A' })).json;
  const b = (await call('POST', '/api/links', { familyId: fam.id, url: 'https://patchnobool.example/b', title: 'B' })).json;
  for (const valor of ['true', 1, 'si', {}, [true]]) {
    const r = await call('PATCH', `/api/links/${b.id}`, { url: 'https://patchnobool.example/a', permitirDuplicado: valor });
    assert.equal(r.status, 409, JSON.stringify(valor));
  }
  const despues = (await call('GET', '/api/data')).json.links.find((l: any) => l.id === b.id);
  assert.equal(despues.url, 'https://patchnobool.example/b');
  void a;
});
