import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/server/db.ts';
import { createApp } from '../src/server/app.ts';
import { setPin, LoginLimiter } from '../src/server/auth.ts';

const PIN = '20261015';
const WRONG_PIN = '999999';
const ORIGIN = 'https://webhub.test';
const ROBOTS = 'noindex, nofollow, noarchive, nosnippet, noimageindex';

async function setup(limiterOpts?: Record<string, any>) {
  const db = openDatabase(null);
  await setPin(db, PIN);
  const limiter = new LoginLimiter(limiterOpts ?? { maxPerIp: 100, windowMs: 60_000 });
  const app = createApp({ db, insecureCookie: true, publicOrigin: ORIGIN, limiter });
  const server = app.server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, server, base, close: () => server.close() };
}

test('X-Robots-Tag exacta en GET /', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en GET /styles.css', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/styles.css');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en GET /app.js', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/app.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en archivo estático inexistente (404)', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/no-existe.css');
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en ruta de aplicación sin extensión', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/ruta-de-app');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en GET /api/session sin sesión', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/api/session');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en GET /api/data sin sesión (401)', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/api/data');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en POST /api/login con PIN incorrecto (401)', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: WRONG_PIN }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en petición sin X-WebHub a ruta de escritura (403)', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/api/aspecto', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tema: 'claro' }),
    });
    // puede ser 401 o 403 según orden; el spec pide 403 para sin X-WebHub
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en método no permitido (405)', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/api/session', { method: 'PUT' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en GET /api/accesos con sesión (200)', async () => {
  const { base, close } = await setup();
  try {
    const lr = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: PIN }),
    });
    const cookieStr = (lr.headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await fetch(base + '/api/accesos', { headers: { Cookie: cookieStr } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en GET /icon/ejemplo.com', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/icon/ejemplo.com');
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('X-Robots-Tag exacta en respuesta 429', async () => {
  const { base, close } = await setup({ maxPerIp: 1 });
  try {
    await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: WRONG_PIN }),
    });
    const res = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WebHub': '1' },
      body: JSON.stringify({ pin: WRONG_PIN }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-robots-tag'), ROBOTS);
  } finally { close(); }
});

test('GET /robots.txt sin sesión: 200, text/plain y cuerpo exacto', async () => {
  const { base, close } = await setup();
  try {
    const res = await fetch(base + '/robots.txt');
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/plain'));
    const body = await res.text();
    assert.equal(body, 'User-agent: *\nDisallow: /\n');
  } finally { close(); }
});

test('public/robots.txt en disco tiene el contenido exacto', () => {
  const content = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.equal(content, 'User-agent: *\nDisallow: /\n');
});

test('index.html contiene la etiqueta meta robots con noindex y nofollow', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta[^>]*name=["']robots["'][^>]*>/i);
  assert.match(html, /noindex/i);
  assert.match(html, /nofollow/i);
});