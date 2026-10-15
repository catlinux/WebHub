import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { getFavicon } from '../src/server/favicons.ts';
import { checkUrl } from '../src/server/checker.ts';
import {
  esDireccionInterna,
  RedInternaError,
  lookupSeguro,
  fetchLimited,
  permitirRedesPrivadas,
  describeError,
} from '../src/server/fetcher.ts';
import { classify } from '../src/shared/check.ts';

function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

// ----- esDireccionInterna -----

const casosEsDireccionInterna: Array<[string, boolean]> = [
  ['172.15.255.255', false],
  ['172.16.0.0', true],
  ['172.31.255.255', true],
  ['172.32.0.0', false],
  ['100.63.255.255', false],
  ['100.64.0.0', true],
  ['100.127.255.255', true],
  ['100.128.0.0', false],
  ['169.254.169.254', true],
  ['169.253.0.1', false],
  ['198.17.255.255', false],
  ['198.18.0.0', true],
  ['198.19.255.255', true],
  ['198.20.0.0', false],
  ['223.255.255.255', false],
  ['224.0.0.0', true],
  ['8.8.8.8', false],
  ['1.1.1.1', false],
  ['::1', true],
  ['::', true],
  ['fe80::1', true],
  ['fc00::1', true],
  ['fd12:3456::1', true],
  ['ff02::1', true],
  ['2001:db8::1', true],
  ['::ffff:127.0.0.1', true],
  ['::ffff:10.0.0.1', true],
  ['::ffff:8.8.8.8', false],
  ['64:ff9b::7f00:1', true],
  ['2606:4700:4700::1111', false],
  ['', true],
  ['abc', true],
  ['999.1.1.1', true],
  ['1.2.3', true],
];

for (const [ip, expected] of casosEsDireccionInterna) {
  test(`esDireccionInterna(${JSON.stringify(ip)}) === ${expected}`, () => {
    assert.equal(esDireccionInterna(ip), expected);
  });
}

test('esDireccionInterna: otros rangos internos y públicos', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '192.168.0.1', '169.254.0.1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '255.255.255.255', '240.0.0.1']) {
    assert.equal(esDireccionInterna(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '198.17.0.1', '198.20.0.1', '223.255.255.254']) {
    assert.equal(esDireccionInterna(ip), false, ip);
  }
});

// ----- RedInternaError -----

test('RedInternaError tiene name correcto', () => {
  const e = new RedInternaError('x');
  assert.equal(e.name, 'RedInternaError');
  assert.ok(e instanceof Error);
});

// ----- lookupSeguro -----

test('lookupSeguro: todas públicas devuelve la primera (callback)', () => {
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
  lookupSeguro('example.com', { family: 4 }, resolver, (err: any, address: any, family: any) => {
    assert.equal(err, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
});

test('lookupSeguro: todas públicas con all devuelve la lista', () => {
  const addrs = [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => cb(null, addrs);
  lookupSeguro('example.com', { all: true }, resolver, (err: any, res: any) => {
    assert.equal(err, null);
    assert.deepEqual(res, addrs);
  });
});

test('lookupSeguro: mezcla de pública e interna → RedInternaError', () => {
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  lookupSeguro('example.com', { all: true }, resolver, (err: any) => {
    assert.ok(err instanceof RedInternaError, String(err));
  });
});

test('lookupSeguro: solo internas → RedInternaError', () => {
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
  lookupSeguro('example.com', { all: true }, resolver, (err: any) => {
    assert.ok(err instanceof RedInternaError, String(err));
  });
});

test('lookupSeguro: promesa se rechaza en mezcla', async () => {
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await assert.rejects(() => lookupSeguro('example.com', { all: true }, resolver), RedInternaError);
});

test('lookupSeguro: literal IP interna bloquea sin resolver', () => {
  let called = false;
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => { called = true; cb(null, [{ address: '8.8.8.8', family: 4 }]); };
  lookupSeguro('127.0.0.1', { all: true }, resolver, (err: any) => {
    assert.ok(err instanceof RedInternaError, String(err));
  });
  assert.equal(called, false);
});

test('lookupSeguro: literal IP pública devuelve dirección', () => {
  let called = false;
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => { called = true; cb(null, [{ address: '8.8.8.8', family: 4 }]); };
  lookupSeguro('[::ffff:8.8.8.8]', {}, resolver, (err: any, address: any, family: any) => {
    // mapped public? esDireccionInterna false, so treated public literal and returns itself (not resolver)
    assert.equal(err, null);
    assert.equal(address, '::ffff:8.8.8.8');
  });
  assert.equal(called, false);
});

test('lookupSeguro: respeta resolver pasado en options.resolver', async () => {
  const resolver = (_host: string, _opts: any, cb: (err: any, addrs: any) => void) => cb(null, [{ address: '9.9.9.9', family: 4 }]);
  const r = await lookupSeguro('example.com', { all: true, resolver });
  assert.deepEqual(r, [{ address: '9.9.9.9', family: 4 }]);
});

// ----- fetchLimited sin permisos -----

test('fetchLimited sin permisos: URLs internas lanzan RedInternaError y cero peticiones', async () => {
  const server = createServer((_req, res) => res.writeHead(200).end('ok'));
  const port = await listen(server, '127.0.0.1');
  let requests = 0;
  const counting = createServer((_req, res) => { requests++; res.writeHead(200).end('ok'); });
  const cport = await listen(counting, '127.0.0.1');
  try {
    const urls = [
      `http://127.0.0.1:${cport}/`,
      `http://localhost:${cport}/`,
      `http://[::1]:${cport}/`,
      `http://2130706433:${cport}/`,
      `http://0.0.0.0:${cport}/`,
      `http://0x7f.0.0.1:${cport}/`,
    ];
    for (const u of urls) {
      requests = 0;
      await assert.rejects(() => fetchLimited(u), (e: any) => e instanceof RedInternaError, u);
      assert.equal(requests, 0, u);
    }
  } finally {
    server.close();
    counting.close();
  }
});

test('fetchLimited: protocolos no http/https lanzan Error', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://x/', 'javascript:alert(1)']) {
    await assert.rejects(() => fetchLimited(u), (e: any) => e instanceof Error, u);
  }
});

// ----- permitirRedesPrivadas con lista -----

test('permitirRedesPrivadas lista: acceso a A y redirección bloqueada a B', async () => {
  const serverB = createServer((_req, res) => { (serverB as any)._hits = ((serverB as any)._hits ?? 0) + 1; res.writeHead(200).end('B'); });
  const portB = await listen(serverB, '127.0.0.1');
  let hitsB = 0;
  serverB.on('request', () => { hitsB++; });
  const serverA = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: `http://127.0.0.1:${portB}/` }).end();
      return;
    }
    if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' }).end();
      return;
    }
    if (req.url === '/rel') {
      res.writeHead(302, { Location: '/target' }).end();
      return;
    }
    if (req.url === '/target') {
      res.writeHead(200).end('final');
      return;
    }
    if (req.url === '/ftp') {
      res.writeHead(302, { Location: 'ftp://example.com/' }).end();
      return;
    }
    res.writeHead(200).end('A');
  });
  const portA = await listen(serverA, '127.0.0.1');
  try {
    permitirRedesPrivadas([`127.0.0.1:${portA}`]);
    const r0 = await fetchLimited(`http://127.0.0.1:${portA}/`);
    assert.equal(r0.status, 200);

    const beforeB = hitsB;
    await assert.rejects(() => fetchLimited(`http://127.0.0.1:${portA}/redirect`), RedInternaError);
    assert.equal(hitsB, beforeB, 'B recibe cero peticiones');

    const rFollow = await fetchLimited(`http://127.0.0.1:${portA}/rel`);
    assert.equal(rFollow.status, 200);
    assert.match(rFollow.url, /\/target$/);

    await assert.rejects(() => fetchLimited(`http://127.0.0.1:${portA}/loop`), /demasiadas redirecciones/);

    await assert.rejects(() => fetchLimited(`http://127.0.0.1:${portA}/ftp`), (e: any) => e instanceof Error);
  } finally {
    permitirRedesPrivadas(false);
    serverA.close();
    serverB.close();
  }
});

// ----- comportamientos conservados con permitir true -----

test('comportamientos conservados: 200, 404, HEAD, content-type, maxBytes', async () => {
  permitirRedesPrivadas(true);
  try {
    const server = createServer((req, res) => {
      if (req.url === '/no') return void res.writeHead(404).end('nope');
      if (req.method === 'HEAD') return void res.writeHead(200, { 'Content-Type': 'text/plain' }).end();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('hola mundo');
    });
    const port = await listen(server, '127.0.0.1');
    try {
      const u = `http://127.0.0.1:${port}`;
      assert.equal((await fetchLimited(`${u}/`)).status, 200);
      assert.equal((await fetchLimited(`${u}/no`)).status, 404);
      const head = await fetchLimited(`${u}/`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      const r = await fetchLimited(`${u}/`);
      assert.match(r.contentType, /text\/plain/);
      const limited = await fetchLimited(`${u}/`, { maxBytes: 3 });
      assert.equal(limited.body.length, 3);
      const empty = await fetchLimited(`${u}/`, { maxBytes: 0 });
      assert.equal(empty.body.length, 0);
    } finally {
      server.close();
    }
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('comportamientos conservados: tiempo agotado → AbortError → tiempo agotado', async () => {
  permitirRedesPrivadas(true);
  try {
    const server = createServer((_req, res) => { setTimeout(() => { res.writeHead(200).end('ok'); }, 200); });
    const port = await listen(server, '127.0.0.1');
    try {
      const err = await fetchLimited(`http://127.0.0.1:${port}/`, { timeoutMs: 50 }).then(() => null, (e: any) => e);
      assert.ok(err);
      assert.equal(err.name, 'AbortError');
      assert.equal(describeError(err), 'tiempo agotado');
    } finally {
      server.close();
    }
  } finally {
    permitirRedesPrivadas(false);
  }
});

test('comportamientos conservados: conexión rechazada → conexión rechazada', async () => {
  permitirRedesPrivadas(true);
  // puerto cerrado
  const server = createServer((_req, res) => res.end());
  const port = await listen(server, '127.0.0.1');
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  try {
    const err = await fetchLimited(`http://127.0.0.1:${port}/`).then(() => null, (e: any) => e);
    assert.ok(err);
    assert.equal(describeError(err), 'conexión rechazada');
  } finally {
    permitirRedesPrivadas(false);
  }
});

// ----- checkUrl, describeError, classify -----

test('checkUrl sin permisos → bloqueado (red interna)', async () => {
  permitirRedesPrivadas(false);
  const server = createServer((_req, res) => res.writeHead(200).end('ok'));
  const port = await listen(server, '127.0.0.1');
  try {
    assert.equal(await checkUrl(`http://127.0.0.1:${port}/`), 'bloqueado (red interna)');
  } finally {
    server.close();
  }
});

test('describeError(RedInternaError) → bloqueado (red interna)', () => {
  assert.equal(describeError(new RedInternaError('x')), 'bloqueado (red interna)');
});

test("classify('bloqueado (red interna)') → aviso", () => {
  assert.equal(classify('bloqueado (red interna)'), 'aviso');
});

// ----- favicons -----

test('getFavicon de host interno no devuelve icono', async () => {
  permitirRedesPrivadas(false);
  const db = openDatabase(null);
  const icon = await getFavicon(db, '127.0.0.1');
  assert.equal(icon, null);
});

test('esDireccionInterna: IPv6 que llevan una IPv4 dentro (compatible, 6to4 y Teredo) se tratan como internas', () => {
  for (const ip of ['::7f00:1', '::127.0.0.1', '::a00:1', '2002:7f00:1::', '2002:a00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2']) {
    assert.equal(esDireccionInterna(ip), true, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4003:80f::200e', '2001:4860:4860::8888']) {
    assert.equal(esDireccionInterna(ip), false, ip);
  }
});

import * as Salida from '../src/server/fetcher.ts';

test('esDireccionInterna: todo el rango fe80::/10 y el obsoleto fec0::/10 son internos; fe7f y fec0+ fuera del rango se evalúan aparte', () => {
  for (const ip of ['fe80::1', 'fe81::1', 'fe90::1', 'febf:ffff::1', 'fec0::1', 'feff::1']) {
    assert.equal(esDireccionInterna(ip), true, ip);
  }
  assert.equal(esDireccionInterna('fe7f::1'), false, 'fe7f está fuera de fe80::/10');
});

test('fetchLimited: tras 5 redirecciones se rinde y no hace más de 6 peticiones en total', async () => {
  let hits = 0;
  const srv = createServer((_req, res) => { hits++; res.writeHead(302, { Location: `/salto${hits}` }); res.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  Salida.permitirRedesPrivadas([`127.0.0.1:${port}`]);
  try {
    await assert.rejects(Salida.fetchLimited(`http://127.0.0.1:${port}/`), /demasiadas redirecciones/);
    assert.equal(hits, 6, 'la petición inicial más 5 redirecciones, ni una más');
  } finally {
    Salida.permitirRedesPrivadas(false);
    srv.close();
  }
});
