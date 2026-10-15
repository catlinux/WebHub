import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin } from '../src/server/auth.ts';
import { permitirRedesPrivadas } from '../src/server/fetcher.ts';
import { LimitadorAnalisis, ErrorAnalisis, analizarUrl } from '../src/server/analisis.ts';
import { Repo } from '../src/server/repo.ts';

const PIN = '20261015';
const ORIGIN = 'https://webhub.test';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function setupApp(extra: Record<string, unknown> = {}): Promise<{ server: Server; base: string; cookie: string; db: any; repo: any }> {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const { server, repo } = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, ...extra } as any);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
    body: JSON.stringify({ pin: PIN }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { server, base, cookie, db, repo };
}

async function call(base: string, cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
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

let main: Awaited<ReturnType<typeof setupApp>>;
let slow: Awaited<ReturnType<typeof setupApp>>;
const mockServers: Server[] = [];

before(async () => {
  main = await setupApp({ analisisLimiter: new LimitadorAnalisis({ max: 1000 }) });
  slow = await setupApp({ analisisTimeoutMs: 300, analisisLimiter: new LimitadorAnalisis({ max: 1000 }) });
});

after(async () => {
  await close(main.server);
  await close(slow.server);
  for (const s of mockServers) await close(s);
  permitirRedesPrivadas(false);
});

test('sin sesión → 401', async () => {
  const saved = main.cookie;
  main.cookie = '';
  assert.equal((await call(main.base, '', 'POST', '/api/links/analizar', { url: 'http://example.com/' })).status, 401);
  main.cookie = saved;
});

test('sin X-WebHub → 403', async () => {
  const res = await fetch(main.base + '/api/links/analizar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: main.cookie },
    body: JSON.stringify({ url: 'http://example.com/' }),
  });
  assert.equal(res.status, 403);
});

test('Origin ajeno → 403', async () => {
  const res = await fetch(main.base + '/api/links/analizar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebHub': '1', Origin: 'https://other.test', Cookie: main.cookie },
    body: JSON.stringify({ url: 'http://example.com/' }),
  });
  assert.equal(res.status, 403);
});

test('validación de url → 400 y cero peticiones al servidor local', async () => {
  // servidor local que cuenta peticiones
  const srv = createServer((_req, res) => { (srv as any)._hits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><title>x</title></html>'); });
  (srv as any)._hits = 0;
  mockServers.push(srv);
  const port = await listen(srv);

  const bads: any[] = [undefined, 1, null, {}, '', 'a'.repeat(2049), 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y'];
  // need body url absent -> {}
  const requests = bads.map((b) => {
    const body = b === undefined ? {} : (typeof b === 'object' && b !== null && !Array.isArray(b) && !(b instanceof String) ? ( (b as any) === (b as any) ? { url: b } : { url: b } ) : { url: b });
    // simpler:
    return { url: (b === undefined ? undefined : b) };
  });
  // reset
  (srv as any)._hits = 0;
  for (const b of bads) {
    const body = (b === undefined) ? {} : { url: b };
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', body);
    assert.equal(r.status, 400, String(b));
  }
  assert.equal((srv as any)._hits, 0, 'el servidor local no debe recibir peticiones');
});

test('página HTML normal → 200 con campos esperados', async () => {
  const srv = createServer((_req, res) => {
    const html = '<!doctype html><html><head><title>Mi Título</title><meta name="description" content="Una descripción"><meta name="keywords" content="palabra, clave, otra"></head><body></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/ruta` });
    assert.equal(r.status, 200);
    assert.equal(r.json.titulo, 'Mi Título');
    assert.equal(r.json.descripcion, 'Una descripción');
    assert.ok(Array.isArray(r.json.etiquetas));
    assert.ok(r.json.etiquetas.includes('palabra'));
    assert.equal(r.headers.get('content-type')?.includes('application/json'), true);
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('charset iso-8859-1 se decodifica bien', async () => {
  const srv = createServer((_req, res) => {
    const html = '<!doctype html><html><head><title>Niño café</title><meta name="description" content="Descripción acentuada"></head></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
    res.end(Buffer.from(html, 'latin1'));
  });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
    assert.equal(r.status, 200);
    assert.equal(r.json.titulo, 'Niño café');
    assert.equal(r.json.descripcion, 'Descripción acentuada');
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('URL final tras redirección se sigue y se usa para reglas de dominio', async () => {
  const srvB = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Hola</title></head></html>');
  });
  const srvA = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(srvB.address() as AddressInfo).port}/` });
    res.end();
  });
  mockServers.push(srvB, srvA);
  await new Promise<void>((r) => srvB.listen(0, '127.0.0.1', r));
  // re-create srvA handler with port known? Location already uses dynamic read; using function redirect instead:
  srvA.removeAllListeners('request');
  srvA.on('request', (_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(srvB.address() as AddressInfo).port}/` });
    res.end();
  });
  const portA = await listen(srvA);
  const _portB = (srvB.address() as AddressInfo).port;
  permitirRedesPrivadas([`127.0.0.1:${portA}`, `127.0.0.1:${_portB}`]);
  try {
    // petición inicial a /docs (regla documentación) pero final es /
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${portA}/docs` });
    assert.equal(r.status, 200);
    assert.equal(r.json.titulo, 'Hola');
    assert.ok(!r.json.etiquetas.includes('documentación'));
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('etiquetas ya usadas aparecen primero con su grafía', async () => {
  const f = main.repo.createFamily({ name: 'F' });
  main.repo.createLink({ familyId: f.id, url: 'example.com', tags: ['Café'] });

  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>cafe</title></head></html>');
  });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
    assert.equal(r.status, 200);
    assert.ok(r.json.etiquetas.includes('Café'));
    assert.equal(r.json.etiquetas[0], 'Café');
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('página no HTML → 422 mensaje estándar', async () => {
  for (const ct of ['image/png', 'application/json']) {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': ct });
      res.end('x');
    });
    mockServers.push(srv);
    const port = await listen(srv);
    permitirRedesPrivadas([`127.0.0.1:${port}`]);
    try {
      const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
      assert.equal(r.status, 422, ct);
      assert.equal(r.json.error, 'La dirección no devuelve una página web.');
    } finally {
      permitirRedesPrivadas(false);
    }
  }
});

test('respuesta 404 y 500 de la página → 422', async () => {
  for (const st of [404, 500]) {
    const srv = createServer((_req, res) => {
      res.writeHead(st, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    mockServers.push(srv);
    const port = await listen(srv);
    permitirRedesPrivadas([`127.0.0.1:${port}`]);
    try {
      const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
      assert.equal(r.status, 422, String(st));
    } finally {
      permitirRedesPrivadas(false);
    }
  }
});

test('servidor que no responde → 504', async () => {
  const srv = createServer((_req, _res) => { /* nunca responde */ });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const r = await call(slow.base, slow.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
    assert.equal(r.status, 504);
  } finally {
    permitirRedesPrivadas(false);
    srv.close(() => {});
  }
});

test('conexión rechazada → 502', async () => {
  const srv = createServer((_req, res) => { res.end('x'); });
  mockServers.push(srv);
  const port = await listen(srv);
  await close(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  let r;
  try {
    r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
  } finally {
    permitirRedesPrivadas(false);
  }
  assert.equal(r.status, 502);
});

test('direcciones internas sin permisos → 422 y cero peticiones', async () => {
  const srv = createServer((_req, res) => { (srv as any)._hits = ((srv as any)._hits || 0) + 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); });
  (srv as any)._hits = 0;
  mockServers.push(srv);
  const port = await listen(srv);
  const before = (srv as any)._hits;
  permitirRedesPrivadas(false);
  const urls = [
    `http://127.0.0.1:${port}/`,
    `http://localhost:${port}/`,
    'http://169.254.169.254/',
    `http://[::1]:${port}/`,
    `http://2130706433:${port}/`,
  ];
  for (const u of urls) {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: u });
    assert.equal(r.status, 422, u);
    assert.equal(r.json.error, 'No se puede analizar una dirección interna.', u);
  }
  assert.equal((srv as any)._hits, before, 'servidor recibe cero');
});

test('redirección permitida hacia servidor local no permitido → 422 bloqueada y cero peticiones al segundo', async () => {
  const srvB = createServer((_req, res) => { (srvB as any)._hits = ((srvB as any)._hits || 0) + 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html></html>'); });
  (srvB as any)._hits = 0;
  const srvA = createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${(srvB.address() as AddressInfo).port}/` });
    res.end();
  });
  mockServers.push(srvB, srvA);
  await new Promise<void>((r) => srvB.listen(0, '127.0.0.1', r));
  const portA = await listen(srvA);
  const before = (srvB as any)._hits;
  permitirRedesPrivadas([`127.0.0.1:${portA}`]);
  try {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${portA}/` });
    assert.equal(r.status, 422);
    assert.equal(r.json.error, 'No se puede analizar una dirección interna.');
  } finally {
    permitirRedesPrivadas(false);
  }
  assert.equal((srvB as any)._hits, before, 'segundo servidor recibe cero');
});

test('página > 256 KB solo se lee hasta el tope, título inicial sí se obtiene', async () => {
  const pad = 'a'.repeat(300 * 1024);
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write('<html><head><title>Grande</title></head><body>');
    res.write(pad);
    res.end('</body></html>');
  });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
    assert.equal(r.status, 200);
    assert.equal(r.json.titulo, 'Grande');
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('contenido hostil en título se devuelve como texto dentro del JSON', async () => {
  const srv = createServer((_req, res) => {
    const html = '<html><head><title>&lt;script&gt;alert(1)&lt;/script&gt;</title></head></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const r = await call(main.base, main.cookie, 'POST', '/api/links/analizar', { url: `http://127.0.0.1:${port}/` });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<script>alert(1)</script>'));
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('LimitadorAnalisis unidad: ventana deslizante con reloj inyectado', () => {
  const clock = { now: 0 };
  const rl = new LimitadorAnalisis({ max: 2, ventanaMs: 1000, reloj: () => clock.now });
  assert.equal(rl.permitir(), true);
  assert.equal(rl.permitir(), true);
  assert.equal(rl.permitir(), false);
  clock.now = 1000;
  assert.equal(rl.permitir(), true);
});

test('limite de uso: cuarta llamada seguida → 429 con Retry-After 60', async () => {
  const lim = new LimitadorAnalisis({ max: 3 });
  const app = await setupApp({ analisisLimiter: lim });
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>t</title></head></html>');
  });
  mockServers.push(srv);
  const port = await listen(srv);
  permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    const u = `http://127.0.0.1:${port}/`;
    const hitsBefore = 0;
    let srvHits = 0;
    srv.on('request', () => { srvHits++; });
    for (let i = 0; i < 3; i++) {
      const r = await call(app.base, app.cookie, 'POST', '/api/links/analizar', { url: u });
      assert.equal(r.status, 200, `llamada ${i + 1}`);
    }
    const r4 = await call(app.base, app.cookie, 'POST', '/api/links/analizar', { url: u });
    assert.equal(r4.status, 429);
    assert.equal(r4.headers.get('retry-after'), '60');
    assert.equal(r4.json.error, 'Demasiados análisis seguidos. Espera un minuto.');
    // no nueva petición al servidor local en la 4ª
    assert.equal(srvHits, 3);
  } finally {
    permitirRedesPrivadas(false);
    await close(app.server);
  }
});

test('el limitador cuenta también llamadas con URL no válida', async () => {
  const lim = new LimitadorAnalisis({ max: 3 });
  const app = await setupApp({ analisisLimiter: lim });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await call(app.base, app.cookie, 'POST', '/api/links/analizar', { url: 'javascript:alert(1)' });
      assert.equal(r.status, 400, `llamada ${i + 1}`);
    }
    const r4 = await call(app.base, app.cookie, 'POST', '/api/links/analizar', { url: 'javascript:alert(1)' });
    assert.equal(r4.status, 429);
  } finally {
    await close(app.server);
  }
});

test('repo.usedTags: orden por frecuencia y luego alfabético, distintas, tope 500', async () => {
  const tmp = await setupApp();
  const f = tmp.repo.createFamily({ name: 'F' });
  tmp.repo.createLink({ familyId: f.id, url: 'a.com', tags: ['zeta', 'vps'] });
  tmp.repo.createLink({ familyId: f.id, url: 'b.com', tags: ['vps', 'alpha', 'zeta'] });
  tmp.repo.createLink({ familyId: f.id, url: 'c.com', tags: ['Vps', 'vps'] });
  const tags = tmp.repo.usedTags();
  // vps appears twice+? exact: 'vps' twice ('vps','vps'), 'Vps' once distinct, zeta twice, alpha once
  assert.ok(tags.includes('vps'));
  assert.ok(tags.includes('Vps'));
  // orden frecuencia desc: vps/vps? exact counts: 'vps'=2? first link vps + second vps =2 (third 'vps' gives 3) actually third has 'vps' lowercase -> 3. 'zeta'=2, 'alpha'=1, 'Vps'=1.
  assert.equal(tags[0], 'vps');
  // tope de 500
  const big = tmp.repo;
  const ff = big.createFamily({ name: 'Big' });
  for (let i = 0; i < 30; i++) {
    const tgs: string[] = [];
    for (let j = 0; j < 20; j++) tgs.push(`tag${i * 20 + j}`);
    big.createLink({ familyId: ff.id, url: `x${i}.com`, tags: tgs });
  }
  const bigTags = big.usedTags();
  assert.equal(bigTags.length, 500);
  await close(tmp.server);
});

test('analizarUrl se exporta y ErrorAnalisis tiene motivo', () => {
  const e = new ErrorAnalisis('url');
  assert.equal(e.motivo, 'url');
  assert.ok(e instanceof Error);
});

import { LimitadorAnalisis as LimitadorPorDefecto } from '../src/server/analisis.ts';

test('LimitadorAnalisis por defecto: 20 análisis por minuto con ventana exacta', () => {
  let t = 1_000_000;
  const l = new LimitadorPorDefecto({ reloj: () => t });
  for (let i = 0; i < 20; i++) assert.equal(l.permitir(), true, `llamada ${i + 1}`);
  assert.equal(l.permitir(), false, 'la 21 se rechaza');
  t += 59_999;
  assert.equal(l.permitir(), false, 'a 59,999 s sigue rechazando');
  t += 1;
  assert.equal(l.permitir(), true, 'a los 60 s vuelve a permitir');
});
