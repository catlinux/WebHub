import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPassword, LoginLimiter } from '../src/server/auth.ts';
import { iconHrefsFromHtml } from '../src/server/favicons.ts';
import { classify, checkUrl } from '../src/server/checker.ts';

const PASSWORD = 'clave-de-prueba-larga';
let server: Server;
let base: string;
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
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  const db = openDatabase(null);
  await setPassword(db, PASSWORD);
  server = createApp({ db, limiter: new LoginLimiter(3, 50, 60_000) }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('sin sesión la API devuelve 401 y la sesión aparece como no iniciada', async () => {
  assert.equal((await call('GET', '/api/data')).status, 401);
  assert.equal((await call('POST', '/api/families', { name: 'x' })).status, 401);
  const s = await call('GET', '/api/session');
  assert.deepEqual(s.json, { authenticated: false, configured: true });
});

test('la página se sirve con cabeceras de seguridad', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const traversal = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(traversal.status, 404);
});

test('login: rechaza sin cabecera anti-CSRF y con Origin ajeno', async () => {
  assert.equal((await call('POST', '/api/login', { password: PASSWORD }, { 'X-WebHub': '' })).status, 403);
  assert.equal((await call('POST', '/api/login', { password: PASSWORD }, { Origin: 'https://malo.example' })).status, 403);
});

test('login: contraseña incorrecta da 401 y al tercer fallo 429', async () => {
  const ip = { 'X-Forwarded-For': '9.9.9.9' }; // ignorada: trustProxy está desactivado
  assert.equal((await call('POST', '/api/login', { password: 'mal' }, ip)).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'mal' })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'mal' })).status, 401);
  const blocked = await call('POST', '/api/login', { password: PASSWORD });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('login correcto: cookie httpOnly, Secure y SameSite', async () => {
  // Servidor aparte para no arrastrar el bloqueo del test anterior.
  const db = openDatabase(null);
  await setPassword(db, PASSWORD);
  const { server: s2 } = createApp({ db });
  await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  s2.close();
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie') ?? '';
  assert.match(set, /webhub_sesion=[\w-]{20,}/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Secure/);
});

test('flujo completo autenticado', async (t) => {
  // Inicia sesión en un servidor nuevo (el principal quedó bloqueado a propósito).
  const db = openDatabase(null);
  await setPassword(db, PASSWORD);
  server.close();
  server = createApp({ db, insecureCookie: true }).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call('POST', '/api/login', { password: PASSWORD });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.doesNotMatch(login.headers.get('set-cookie')!, /Secure/);

  let prov: number, redes: number, sub: number;
  await t.test('familias y subfamilias', async () => {
    prov = (await call('POST', '/api/families', { name: 'Proveedores' })).json.id;
    redes = (await call('POST', '/api/families', { name: 'Redes' })).json.id;
    sub = (await call('POST', '/api/families', { name: 'Dominios', parentId: prov })).json.id;
    const deep = await call('POST', '/api/families', { name: 'Demasiado', parentId: sub });
    assert.equal(deep.status, 400);
    assert.match(deep.json.error, /subfamilias/);
    assert.equal((await call('PATCH', `/api/families/${prov}`, { parentId: redes })).status, 400);
    assert.equal((await call('POST', '/api/families', { name: '  ' })).status, 400);
  });

  await t.test('enlaces: validación de URL', async () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '']) {
      const r = await call('POST', '/api/links', { familyId: prov, url: bad, title: 'x' });
      assert.equal(r.status, 400, bad);
    }
    const ok = await call('POST', '/api/links', { familyId: prov, url: 'ovh.com', title: '', tags: 'vps, dns', note: 'Servidor' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.url, 'https://ovh.com/');
    assert.equal(ok.json.title, 'ovh.com');
    assert.deepEqual(ok.json.tags, ['vps', 'dns']);
  });

  await t.test('reordenar, mover entre familias y borrar', async () => {
    const ids: number[] = [];
    for (const n of ['a', 'b', 'c']) ids.push((await call('POST', '/api/links', { familyId: redes, url: `${n}.example.com`, title: n })).json.id);
    assert.equal((await call('PUT', '/api/links/order', { familyId: redes, ids: [ids[2], ids[0], ids[1]] })).status, 200);
    assert.equal((await call('PUT', '/api/links/order', { familyId: redes, ids: [ids[0], ids[1]] })).status, 400);
    let data = (await call('GET', '/api/data')).json;
    const titles = (fid: number) => data.links.filter((l: any) => l.familyId === fid).sort((a: any, b: any) => a.position - b.position).map((l: any) => l.title);
    assert.deepEqual(titles(redes), ['c', 'a', 'b']);
    assert.equal((await call('PATCH', `/api/links/${ids[0]}`, { familyId: prov })).status, 200);
    data = (await call('GET', '/api/data')).json;
    assert.deepEqual(titles(prov), ['ovh.com', 'a']);
    assert.equal((await call('DELETE', `/api/links/${ids[1]}`)).status, 200);
    assert.equal((await call('PUT', '/api/families/order', { parentId: null, ids: [redes, prov] })).status, 200);
    data = (await call('GET', '/api/data')).json;
    assert.deepEqual(data.families.filter((f: any) => f.parentId === null).map((f: any) => f.name), ['Redes', 'Proveedores']);
  });

  await t.test('contador de clics', async () => {
    const id = (await call('GET', '/api/data')).json.links[0].id;
    assert.equal((await call('POST', `/api/links/${id}/click`)).status, 204);
    await call('POST', `/api/links/${id}/click`);
    const link = (await call('GET', '/api/data')).json.links.find((l: any) => l.id === id);
    assert.equal(link.clicks, 2);
  });

  await t.test('importar marcadores: vista previa y confirmación sin duplicados', async () => {
    const html = readFileSync(new URL('./fixtures/chrome.html', import.meta.url), 'utf8');
    const preview = await call('POST', '/api/import/bookmarks/preview', { html });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.invalid, 1);
    const provGroup = preview.json.groups.find((g: any) => g.name === 'Proveedores');
    assert.equal(provGroup.existingFamilyId, prov, 'reutiliza la familia existente');
    const before = (await call('GET', '/api/data')).json;
    const res = await call('POST', '/api/import/bookmarks/confirm', { html, excluded: ['otros marcadores'], skipDuplicates: true });
    assert.equal(res.status, 200);
    const after = (await call('GET', '/api/data')).json;
    assert.equal(after.links.length - before.links.length, res.json.links);
    assert.equal(res.json.links, 6, 'ocho válidos menos un duplicado y uno excluido');
    assert.ok(!after.families.some((f: any) => f.name === 'Otros marcadores'));
    assert.equal(after.families.filter((f: any) => f.name === 'Proveedores').length, 1);
    const again = await call('POST', '/api/import/bookmarks/confirm', { html, skipDuplicates: true });
    assert.equal(again.json.links, 1, 'solo entra MDN, que antes se excluyó');
  });

  await t.test('exportar e importar JSON conserva todo', async () => {
    const exp = await call('GET', '/api/export');
    assert.match(exp.headers.get('content-disposition') ?? '', /webhub-\d{4}-\d{2}-\d{2}\.json/);
    const dump = exp.json;
    assert.equal(dump.app, 'WebHub');
    assert.ok(!JSON.stringify(dump).includes('scrypt'), 'la copia no incluye el hash');
    const before = (await call('GET', '/api/data')).json;
    assert.equal((await call('POST', '/api/import/json', { data: dump })).status, 400, 'exige confirmación');
    assert.equal((await call('POST', '/api/import/json', { data: { app: 'Otra' }, confirm: 'SUSTITUIR' })).status, 400);
    const bad = structuredClone(dump);
    bad.links.push({ familyId: 99999, title: 'huérfano', url: 'https://x.y' });
    assert.equal((await call('POST', '/api/import/json', { data: bad, confirm: 'SUSTITUIR' })).status, 400);
    assert.equal((await call('GET', '/api/data')).json.links.length, before.links.length, 'un error no deja datos a medias');
    const ok = await call('POST', '/api/import/json', { data: dump, confirm: 'SUSTITUIR' });
    assert.equal(ok.status, 200);
    const after = (await call('GET', '/api/data')).json;
    const shape = (s: any) => s.families.map((f: any) => {
      const parent = s.families.find((p: any) => p.id === f.parentId);
      const links = s.links.filter((l: any) => l.familyId === f.id).sort((a: any, b: any) => a.position - b.position);
      return [f.name, parent?.name ?? null, links.map((l: any) => [l.title, l.url, l.clicks, l.tags.join()])];
    });
    assert.deepEqual(shape(after), shape(before));
  });

  await t.test('borrar familia elimina subfamilias y enlaces', async () => {
    const data = (await call('GET', '/api/data')).json;
    const p = data.families.find((f: any) => f.name === 'Proveedores');
    assert.equal((await call('DELETE', `/api/families/${p.id}`)).status, 200);
    const after = (await call('GET', '/api/data')).json;
    const gone = new Set([p.id, ...data.families.filter((f: any) => f.parentId === p.id).map((f: any) => f.id)]);
    assert.ok(!after.links.some((l: any) => gone.has(l.familyId)));
    assert.ok(!after.families.some((f: any) => gone.has(f.id)));
  });

  await t.test('iconos solo de dominios conocidos', async () => {
    assert.equal((await call('GET', '/icon/no-esta.example')).status, 404);
  });

  await t.test('logout invalida la cookie', async () => {
    assert.equal((await call('POST', '/api/logout')).status, 200);
    assert.equal((await call('GET', '/api/data')).status, 401);
  });
});

test('iconHrefsFromHtml resuelve rutas relativas y prefiere icon a apple-touch', () => {
  const html = `<link rel="apple-touch-icon" href="/apple.png"><link rel='shortcut icon' href='img/fav.png?v=1&amp;x=2'><link rel=stylesheet href=a.css>`;
  assert.deepEqual(iconHrefsFromHtml(html, 'https://ej.com/dir/'), ['https://ej.com/dir/img/fav.png?v=1&x=2', 'https://ej.com/apple.png']);
});

test('comprobador: clasifica estados y prueba contra un servidor local', async () => {
  assert.equal(classify('200'), 'ok');
  assert.equal(classify('301'), 'ok');
  assert.equal(classify('403'), 'aviso');
  assert.equal(classify('503'), 'aviso');
  assert.equal(classify('404'), 'roto');
  assert.equal(classify('dominio no encontrado'), 'roto');
  assert.equal(classify(null), null);
  const local = createServer((req, res) => {
    if (req.url === '/sin-head' && req.method === 'HEAD') return void res.writeHead(405).end();
    res.writeHead(req.url === '/no' ? 404 : 200).end('hola');
  });
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  assert.equal(await checkUrl(`${u}/`), '200');
  assert.equal(await checkUrl(`${u}/no`), '404');
  assert.equal(await checkUrl(`${u}/sin-head`), '200');
  await new Promise((r) => local.close(r));
  assert.equal(await checkUrl(`${u}/`), 'conexión rechazada', 'servidor ya cerrado');
});
