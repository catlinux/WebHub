import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (ctx: Ctx) => Promise<void> | void;

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  url: URL;
  ip: string;
}

export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

/** Router mínimo: rutas con parámetros «:nombre», sin dependencias. */
export class Router {
  private routes: { method: string; parts: string[]; handler: Handler }[] = [];

  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.parts.every((p, i) => {
        const seg = parts[i] as string;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(seg);
          } catch {
            return false;
          }
          return true;
        }
        return p === seg;
      });
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limitBytes) throw new HttpError(413, 'Petición demasiado grande.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, 'Petición demasiado grande.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limitBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Se esperaba JSON.');
  }
  const raw = await readBody(req, limitBytes);
  try {
    const value = JSON.parse(raw.toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'JSON no válido.');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // Caddy añade la IP real al final de X-Forwarded-For; es la única entrada fiable.
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const last = xff[xff.length - 1];
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'desconocida';
}

export function idParam(ctx: Ctx, name = 'id'): number {
  const id = Number(ctx.params[name]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, 'No encontrado.');
  return id;
}
