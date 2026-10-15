import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { Router, HttpError, sendJson, readJson, parseCookies, clientIp, idParam, type Ctx } from './http.ts';
import { Repo, InputError } from './repo.ts';
import { LoginLimiter, createSession, deleteSession, getPasswordHash, isValidSession, verifyPassword } from './auth.ts';
import { LinkChecker } from './checker.ts';
import { getFavicon } from './favicons.ts';
import { parseBookmarksHtml, planImport } from '../shared/bookmarks.ts';

export interface AppOptions {
  db: DatabaseSync;
  publicDir?: string;
  insecureCookie?: boolean;
  trustProxy?: boolean;
  publicOrigin?: string;
  sessionDays?: number;
  limiter?: LoginLimiter;
  checker?: LinkChecker;
}

const COOKIE = 'webhub_sesion';
const BIG_BODY = 20 * 1024 * 1024;
const DEFAULT_PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

export function createApp(opts: AppOptions): { server: Server; repo: Repo } {
  const repo = new Repo(opts.db);
  const db = opts.db;
  const limiter = opts.limiter ?? new LoginLimiter();
  const checker = opts.checker ?? new LinkChecker(repo);
  const publicDir = opts.publicDir ?? DEFAULT_PUBLIC;
  const sessionDays = opts.sessionDays ?? 30;

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${opts.insecureCookie ? '' : '; Secure'}`;
  const token = (req: IncomingMessage) => parseCookies(req.headers.cookie)[COOKIE];
  const authed = (req: IncomingMessage) => isValidSession(db, token(req));

  const api = new Router();

  api.on('GET', '/api/session', ({ req, res }) => {
    sendJson(res, 200, { authenticated: authed(req), configured: getPasswordHash(db) !== null });
  });

  api.on('POST', '/api/login', async ({ req, res, ip }) => {
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      throw new HttpError(429, `Demasiados intentos. Prueba de nuevo en ${Math.ceil(wait / 60)} min.`, { 'Retry-After': String(wait) });
    }
    const body = await readJson(req, 4096);
    const hash = getPasswordHash(db);
    if (!hash) throw new HttpError(503, 'Aún no hay contraseña. Créala en el servidor con «npm run password».');
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || password.length > 1024 || !(await verifyPassword(password, hash))) {
      limiter.fail(ip);
      throw new HttpError(401, 'Contraseña incorrecta.');
    }
    limiter.succeed(ip);
    const session = createSession(db, sessionDays);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(session.token, sessionDays * 86400) });
  });

  api.on('POST', '/api/logout', ({ req, res }) => {
    deleteSession(db, token(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  });

  // A partir de aquí, todo exige sesión (comprobado en handle()).
  api.on('GET', '/api/data', ({ res }) => sendJson(res, 200, repo.snapshot()));

  api.on('POST', '/api/families', async (ctx) => sendJson(ctx.res, 201, repo.createFamily(await readJson(ctx.req))));
  api.on('PATCH', '/api/families/:id', async (ctx) => sendJson(ctx.res, 200, repo.updateFamily(idParam(ctx), await readJson(ctx.req))));
  api.on('DELETE', '/api/families/:id', (ctx) => {
    repo.deleteFamily(idParam(ctx));
    sendJson(ctx.res, 200, { ok: true });
  });
  api.on('PUT', '/api/families/order', async (ctx) => {
    const body = await readJson(ctx.req);
    repo.reorderFamilies(typeof body.parentId === 'number' ? body.parentId : null, body.ids);
    sendJson(ctx.res, 200, { ok: true });
  });

  api.on('POST', '/api/links', async (ctx) => sendJson(ctx.res, 201, repo.createLink(await readJson(ctx.req))));
  api.on('PATCH', '/api/links/:id', async (ctx) => sendJson(ctx.res, 200, repo.updateLink(idParam(ctx), await readJson(ctx.req))));
  api.on('DELETE', '/api/links/:id', (ctx) => {
    repo.deleteLink(idParam(ctx));
    sendJson(ctx.res, 200, { ok: true });
  });
  api.on('PUT', '/api/links/order', async (ctx) => {
    const body = await readJson(ctx.req);
    repo.reorderLinks(Number(body.familyId), body.ids);
    sendJson(ctx.res, 200, { ok: true });
  });
  api.on('POST', '/api/links/:id/click', (ctx) => {
    repo.registerClick(idParam(ctx));
    ctx.res.writeHead(204).end();
  });

  const planFrom = (body: Record<string, unknown>) => {
    if (typeof body.html !== 'string' || !body.html.trim()) throw new InputError('Falta el archivo de marcadores.');
    const tree = parseBookmarksHtml(body.html);
    const families = repo.snapshot().families.map(({ id, name, parentId }) => ({ id, name, parentId }));
    return planImport(tree, { existingUrls: repo.allUrls(), existingFamilies: families, unwrapContainers: body.unwrapContainers !== false });
  };
  api.on('POST', '/api/import/bookmarks/preview', async (ctx) => sendJson(ctx.res, 200, planFrom(await readJson(ctx.req, BIG_BODY))));
  api.on('POST', '/api/import/bookmarks/confirm', async (ctx) => {
    const body = await readJson(ctx.req, BIG_BODY);
    const excluded = Array.isArray(body.excluded) ? body.excluded.map(String) : [];
    sendJson(ctx.res, 200, repo.applyImport(planFrom(body), { excluded, skipDuplicates: body.skipDuplicates !== false }));
  });

  api.on('GET', '/api/export', ({ res }) => {
    const date = new Date().toISOString().slice(0, 10);
    sendJson(res, 200, repo.exportJson(), { 'Content-Disposition': `attachment; filename="webhub-${date}.json"` });
  });
  api.on('POST', '/api/import/json', async (ctx) => {
    const body = await readJson(ctx.req, BIG_BODY);
    if (body.confirm !== 'SUSTITUIR') throw new InputError('Falta la confirmación.');
    sendJson(ctx.res, 200, repo.importJson(body.data));
  });

  api.on('POST', '/api/check', ({ res }) => sendJson(res, 202, checker.start()));
  api.on('GET', '/api/check', ({ res }) => sendJson(res, 200, checker.job ?? { running: false, total: 0, done: 0 }));

  api.on('GET', '/icon/:host', async ({ res, params }) => {
    const host = params.host ?? '';
    if (!/^[a-z0-9.-]{1,253}$/i.test(host) || !repo.hostKnown(host)) throw new HttpError(404, 'Sin icono.');
    const icon = await getFavicon(db, host);
    if (!icon) {
      res.writeHead(404, { 'Cache-Control': 'private, max-age=86400' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': icon.mime,
      'Cache-Control': 'private, max-age=604800',
      // Un SVG abierto directamente no debe poder ejecutar nada en nuestro origen.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(icon.data);
  });

  const PUBLIC_API = new Set(['/api/session', '/api/login']);

  function checkOrigin(req: IncomingMessage): void {
    if (req.headers['x-webhub'] !== '1') throw new HttpError(403, 'Petición no permitida.');
    const origin = req.headers.origin;
    if (!origin) return;
    const expected = opts.publicOrigin || null;
    let ok: boolean;
    try {
      ok = expected ? origin === expected : new URL(origin).host === req.headers.host;
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(403, 'Origen no permitido.');
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    let file = normalize(join(publicDir, rel));
    if (!file.startsWith(publicDir)) throw new HttpError(404, 'No encontrado.');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      // Rutas de la aplicación (sin extensión): se sirve index.html.
      if (extname(rel)) throw new HttpError(404, 'No encontrado.');
      rel = 'index.html';
      file = join(publicDir, rel);
      data = await readFile(file);
    }
    const ext = extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ['.png', '.ico'].includes(ext) ? 'public, max-age=86400' : 'no-cache',
      'Content-Length': data.length,
    });
    res.end(data);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    try {
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/icon/');
      if (!isApi) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Método no permitido.');
        await serveStatic(res, url.pathname);
        return;
      }
      const found = api.match(method, url.pathname);
      if (found === null) throw new HttpError(404, 'No encontrado.');
      if (found === 'method') throw new HttpError(405, 'Método no permitido.');
      if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);
      if (!PUBLIC_API.has(url.pathname) && !authed(req)) throw new HttpError(401, 'Sesión no iniciada o caducada.');
      const ctx: Ctx = { req, res, params: found.params, url, ip: clientIp(req, opts.trustProxy ?? false) };
      await found.handler(ctx);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message }, err.headers);
      } else if (err instanceof InputError) {
        sendJson(res, 400, { error: err.message });
      } else {
        // No se registran cuerpos ni cabeceras: pueden contener la contraseña o la cookie.
        console.error(`Error en ${method} ${url.pathname}:`, (err as Error)?.message ?? err);
        sendJson(res, 500, { error: 'Error interno.' });
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  return { server, repo };
}
