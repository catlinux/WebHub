import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { Router, HttpError, sendJson, readJson, parseCookies, clientIp, idParam, type Ctx } from './http.ts';
import { Repo, InputError, DuplicadoError } from './repo.ts';
import { LoginLimiter, PIN_MAX, createSession, deleteSession, getPinHash, isPinLoginEnabled, isValidSession, setPinLoginEnabled, verifySecret } from './auth.ts';
import { LinkChecker } from './checker.ts';
import { ChallengeStore, verifyRegistration, verifyAssertion, WebAuthnError } from './webauthn.ts';
import { listPasskeys, getPasskey, countPasskeys, insertPasskey, updatePasskeyUsage, deletePasskey, getWebAuthnUserId } from './passkeys.ts';
import { getFavicon } from './favicons.ts';
import { getAspecto, setAspecto } from './aspecto.ts';
import { logAccess, listAccess, accessSummary, omittedCount } from './accesos.ts';
import { LimitadorAnalisis, ErrorAnalisis, analizarUrl } from './analisis.ts';
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
  analisisLimiter?: LimitadorAnalisis;
  analisisTimeoutMs?: number;
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
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
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
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp(opts: AppOptions): { server: Server; repo: Repo } {
  const repo = new Repo(opts.db);
  const db = opts.db;
  const limiter = opts.limiter ?? new LoginLimiter();
  const checker = opts.checker ?? new LinkChecker(repo);
  const analisisLimiter = opts.analisisLimiter ?? new LimitadorAnalisis();
  const publicDir = opts.publicDir ?? DEFAULT_PUBLIC;
  const sessionDays = opts.sessionDays ?? 30;
  const regChallenges = new ChallengeStore();
  const loginChallenges = new ChallengeStore();

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${opts.insecureCookie ? '' : '; Secure'}`;
  const token = (req: IncomingMessage) => parseCookies(req.headers.cookie)[COOKIE];
  const authed = (req: IncomingMessage) => isValidSession(db, token(req));
  const expectedOrigin = (req: IncomingMessage) => opts.publicOrigin || `${opts.insecureCookie ? 'http' : 'https'}://${req.headers.host}`;

  const api = new Router();

  api.on('GET', '/api/session', ({ req, res }) => {
    sendJson(res, 200, { authenticated: authed(req), configured: getPinHash(db) !== null, passkeys: countPasskeys(db) > 0, pin: isPinLoginEnabled(db) });
  });

  api.on('POST', '/api/login', async ({ req, res, ip }) => {
    if (!isPinLoginEnabled(db)) {
      const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
      logAccess(db, { kind: 'pin', ok: false, ip, userAgent: ua, detail: 'PIN desactivado' });
      throw new HttpError(403, 'La entrada con PIN está desactivada. Usa la huella.');
    }
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      throw new HttpError(429, `Demasiados intentos. Prueba de nuevo en ${Math.ceil(wait / 60)} min.`, { 'Retry-After': String(wait) });
    }
    const body = await readJson(req, 4096);
    const hash = getPinHash(db);
    if (!hash) throw new HttpError(503, 'Aún no hay PIN. Créalo en el servidor con «npm run pin».');
    const pin = typeof body.pin === 'string' ? body.pin : '';
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
    if (!/^\d+$/.test(pin) || pin.length > PIN_MAX || !(await verifySecret(pin, hash))) {
      const lock = limiter.fail(ip);
      logAccess(db, { kind: 'pin', ok: false, ip, userAgent: ua, detail: 'PIN incorrecto' });
      // Aviso visible en journalctl (nunca se registra el PIN).
      if (lock) {
        console.warn(`Login bloqueado ${Math.round(lock / 60_000)} min tras varios PIN incorrectos seguidos.`);
        logAccess(db, { kind: 'bloqueo', ok: false, ip, userAgent: ua, detail: `Entrada por PIN bloqueada ${Math.round(lock / 60_000)} min` });
      }
      throw new HttpError(401, 'PIN incorrecto.');
    }
    limiter.succeed(ip);
    const session = createSession(db, sessionDays);
    logAccess(db, { kind: 'pin', ok: true, ip, userAgent: ua });
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(session.token, sessionDays * 86400) });
  });

  api.on('POST', '/api/logout', ({ req, res }) => {
    deleteSession(db, token(req));
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  });

  api.on('PUT', '/api/acceso/pin', async ({ req, res, ip }) => {
    const body = await readJson(req, 4096);
    if (typeof (body as { enabled?: unknown }).enabled !== 'boolean') throw new HttpError(400, 'Datos no válidos.');
    const enabled = (body as { enabled: boolean }).enabled;
    if (!enabled && countPasskeys(db) === 0) {
      throw new HttpError(400, 'Registra antes una huella: sin huellas te quedarías sin forma de entrar.');
    }
    setPinLoginEnabled(db, enabled);
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
    logAccess(db, { kind: enabled ? 'pin-activado' : 'pin-desactivado', ok: true, ip, userAgent: ua, detail: '' });
    sendJson(res, 200, { pin: isPinLoginEnabled(db) });
  });

  // A partir de aquí, todo exige sesión (comprobado en handle()).
  api.on('GET', '/api/data', ({ res }) => sendJson(res, 200, repo.snapshot()));

  api.on('GET', '/api/aspecto', ({ res }) => sendJson(res, 200, getAspecto(db)));
  api.on('PUT', '/api/aspecto', async (ctx) => {
    const body = await readJson(ctx.req, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Datos no válidos.');
    const saneado = setAspecto(db, body);
    sendJson(ctx.res, 200, saneado);
  });

  api.on('POST', '/api/families', async (ctx) => sendJson(ctx.res, 201, repo.createFamily(await readJson(ctx.req))));
  api.on('PUT', '/api/families/layout', async (ctx) => {
    const body = await readJson(ctx.req, 16384);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Datos no válidos.');
    const items = (body as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new HttpError(400, 'Datos no válidos.');
    repo.setFamilyLayout(items);
    sendJson(ctx.res, 200, { ok: true });
  });
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

  api.on('POST', '/api/links/analizar', async (ctx) => {
    const body = await readJson(ctx.req, 4096);
    if (!analisisLimiter.permitir()) {
      throw new HttpError(429, 'Demasiados análisis seguidos. Espera un minuto.', { 'Retry-After': '60' });
    }
    const url = (body as Record<string, unknown>).url;
    if (typeof url !== 'string') throw new HttpError(400, 'URL no válida.');
    const timeoutMs = opts.analisisTimeoutMs ?? 8000;
    try {
      const resultado = await analizarUrl(url, repo.usedTags(), timeoutMs);
      sendJson(ctx.res, 200, resultado);
    } catch (err) {
      if (err instanceof ErrorAnalisis) {
        switch (err.motivo) {
          case 'url':
            throw new HttpError(400, 'URL no válida.');
          case 'bloqueada':
            throw new HttpError(422, 'No se puede analizar una dirección interna.');
          case 'no_html':
          case 'estado':
            throw new HttpError(422, 'La dirección no devuelve una página web.');
          case 'tiempo':
            throw new HttpError(504, 'La página tardó demasiado en responder.');
          case 'red':
            throw new HttpError(502, 'No se pudo descargar la página.');
        }
      }
      throw err;
    }
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

  // ---- Passkeys (WebAuthn) ----
  api.on('POST', '/api/webauthn/register-options', ({ req, res }) => {
    const origin = expectedOrigin(req);
    const rpId = new URL(origin).hostname;
    const challenge = regChallenges.create();
    const excludeCredentials = listPasskeys(db).map((p) => ({ type: 'public-key', id: p.id }));
    sendJson(res, 200, {
      challenge,
      rp: { id: rpId, name: 'WebHub' },
      user: { id: getWebAuthnUserId(db), name: 'webhub', displayName: 'WebHub' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { type: 'public-key', alg: -8 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
      attestation: 'none',
      timeout: 120000,
      excludeCredentials,
    });
  });

  api.on('POST', '/api/webauthn/register', async ({ req, res, ip }) => {
    const body = await readJson(req, 16384);
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.id)) throw new HttpError(400, 'Datos no válidos.');
    if (typeof body.clientDataJSON !== 'string') throw new HttpError(400, 'Datos no válidos.');
    if (typeof body.authenticatorData !== 'string') throw new HttpError(400, 'Datos no válidos.');
    if (typeof body.publicKey !== 'string') throw new HttpError(400, 'Datos no válidos.');
    if (typeof body.alg !== 'number' || !Number.isInteger(body.alg)) throw new HttpError(400, 'Datos no válidos.');
    if (body.name !== undefined && typeof body.name !== 'string') throw new HttpError(400, 'Datos no válidos.');

    let name = 'Dispositivo';
    if (typeof body.name === 'string') {
      const trimmed = body.name.trim();
      if (trimmed) {
        if (trimmed.length > 60) throw new HttpError(400, 'Datos no válidos.');
        name = trimmed;
      }
    }

    if (countPasskeys(db) >= 10) throw new HttpError(400, 'Se ha alcanzado el máximo de huellas.');
    if (getPasskey(db, body.id)) throw new HttpError(409, 'Ya existe una huella con ese identificador.');

    const origin = expectedOrigin(req);
    const rpId = new URL(origin).hostname;
    let result: { credentialId: string; publicKey: string; alg: number; signCount: number };
    try {
      result = verifyRegistration({
        id: body.id,
        clientDataJSON: body.clientDataJSON,
        authenticatorData: body.authenticatorData,
        publicKey: body.publicKey,
        alg: body.alg,
        origin,
        rpId,
        challenges: regChallenges,
      });
    } catch (err) {
      if (err instanceof WebAuthnError) throw new HttpError(400, 'No se pudo registrar la huella.');
      throw err;
    }

    const passkey = insertPasskey(db, {
      id: result.credentialId,
      publicKey: result.publicKey,
      alg: result.alg,
      counter: result.signCount,
      name,
    });

    const uaReg = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
    logAccess(db, { kind: 'huella-alta', ok: true, ip, userAgent: uaReg, detail: name });

    sendJson(res, 201, { id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt });
  });

  api.on('GET', '/api/webauthn/credentials', ({ res }) => {
    const list = listPasskeys(db).map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt }));
    sendJson(res, 200, list);
  });

  api.on('DELETE', '/api/webauthn/credentials/:id', ({ req, res, params, ip }) => {
    const id = params.id ?? '';
    const passkey = getPasskey(db, id);
    if (!passkey) throw new HttpError(404, 'No encontrado.');
    if (!isPinLoginEnabled(db) && countPasskeys(db) <= 1) {
      throw new HttpError(409, 'No puedes borrar la última huella con el PIN desactivado. Reactiva antes el PIN.');
    }
    deletePasskey(db, id);
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
    logAccess(db, { kind: 'huella-baja', ok: true, ip, userAgent: ua, detail: passkey.name });
    sendJson(res, 200, { ok: true });
  });

  api.on('POST', '/api/webauthn/login-options', ({ req, res }) => {
    const passkeys = listPasskeys(db);
    if (passkeys.length === 0) throw new HttpError(404, 'No hay huellas registradas.');
    const origin = expectedOrigin(req);
    const rpId = new URL(origin).hostname;
    const challenge = loginChallenges.create();
    sendJson(res, 200, {
      challenge,
      rpId,
      allowCredentials: passkeys.map((p) => ({ type: 'public-key', id: p.id })),
      userVerification: 'required',
      timeout: 120000,
    });
  });

  api.on('POST', '/api/webauthn/login', async ({ req, res, ip }) => {
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
    const failHuella = () => logAccess(db, { kind: 'huella', ok: false, ip, userAgent: ua, detail: 'Huella no válida' });
    const body = await readJson(req, 16384);
    if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.id)) { failHuella(); throw new HttpError(401, 'No se pudo verificar la huella.'); }
    if (typeof body.clientDataJSON !== 'string') { failHuella(); throw new HttpError(401, 'No se pudo verificar la huella.'); }
    if (typeof body.authenticatorData !== 'string') { failHuella(); throw new HttpError(401, 'No se pudo verificar la huella.'); }
    if (typeof body.signature !== 'string') { failHuella(); throw new HttpError(401, 'No se pudo verificar la huella.'); }

    const passkey = getPasskey(db, body.id);
    if (!passkey) { failHuella(); throw new HttpError(401, 'No se pudo verificar la huella.'); }

    const origin = expectedOrigin(req);
    const rpId = new URL(origin).hostname;
    let signCount: number;
    try {
      const result = verifyAssertion({
        clientDataJSON: body.clientDataJSON,
        authenticatorData: body.authenticatorData,
        signature: body.signature,
        publicKey: passkey.publicKey,
        alg: passkey.alg,
        storedCounter: passkey.counter,
        origin,
        rpId,
        challenges: loginChallenges,
      });
      signCount = result.signCount;
    } catch (err) {
      if (err instanceof WebAuthnError) { failHuella(); throw new HttpError(401, 'No se pudo verificar la huella.'); }
      throw err;
    }

    updatePasskeyUsage(db, passkey.id, signCount);
    logAccess(db, { kind: 'huella', ok: true, ip, userAgent: ua, detail: passkey.name });
    const session = createSession(db, sessionDays);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(session.token, sessionDays * 86400) });
  });

  api.on('GET', '/api/accesos', ({ res, url }) => {
    const raw = url.searchParams.get('limite');
    let limit = 50;
    if (raw !== null) {
      const n = Number(raw);
      if (!Number.isFinite(n)) limit = 50;
      else {
        limit = Math.trunc(n);
        if (limit < 1) limit = 1;
        if (limit > 200) limit = 200;
      }
    }
    const entries = listAccess(db, limit);
    sendJson(res, 200, { entries, omitted: omittedCount(db) });
  });

  api.on('GET', '/api/accesos/resumen', ({ res }) => {
    const { fallos, desde } = accessSummary(db);
    sendJson(res, 200, { fallos, desde });
  });

  const PUBLIC_API = new Set(['/api/session', '/api/login', '/api/webauthn/login-options', '/api/webauthn/login']);

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
      } else if (err instanceof DuplicadoError) {
        sendJson(res, 409, { error: err.message, existente: err.existente });
      } else if (err instanceof InputError) {
        sendJson(res, 400, { error: err.message });
      } else {
        // No se registran cuerpos ni cabeceras: pueden contener el PIN o la cookie.
        console.error(`Error en ${method} ${url.pathname}:`, (err as Error)?.message ?? err);
        sendJson(res, 500, { error: 'Error interno.' });
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  return { server, repo };
}
