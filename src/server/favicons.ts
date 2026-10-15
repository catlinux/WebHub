import type { DatabaseSync } from 'node:sqlite';
import { fetchLimited } from './fetcher.ts';

const ALLOWED = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif', 'image/jpeg', 'image/webp', 'image/svg+xml']);
const MAX_BYTES = 200 * 1024;
const RETRY_MS = 7 * 86_400_000;
const REFRESH_MS = 60 * 86_400_000;

export interface Icon { mime: string; data: Buffer }

function mimeOf(contentType: string, body: Buffer): string | null {
  let mime = contentType.split(';')[0]!.trim().toLowerCase();
  // Muchos servidores sirven favicon.ico como octet-stream o text/plain.
  if (!ALLOWED.has(mime)) {
    if (body.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) mime = 'image/x-icon';
    else if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png';
    else return null;
  }
  return body.length > 0 ? mime : null;
}

async function tryIcon(url: string): Promise<Icon | null> {
  try {
    const r = await fetchLimited(url, { timeoutMs: 6000, maxBytes: MAX_BYTES + 1, accept: 'image/*' });
    if (r.status !== 200 || r.body.length > MAX_BYTES) return null;
    const mime = mimeOf(r.contentType, r.body);
    return mime ? { mime, data: r.body } : null;
  } catch {
    return null;
  }
}

/** Busca <link rel="icon"> en la portada. */
export function iconHrefsFromHtml(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!/\b(icon|apple-touch-icon)\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[2] ?? href?.[3] ?? href?.[4];
    if (!value) continue;
    try {
      const abs = new URL(value.replace(/&amp;/g, '&'), base);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') out.push(abs.href);
    } catch {
      /* se ignora */
    }
  }
  // Preferimos los iconos «icon» normales a los apple-touch (más grandes).
  return out.sort((a, b) => Number(/apple/i.test(a)) - Number(/apple/i.test(b)));
}

async function discover(host: string): Promise<Icon | null> {
  const origin = `https://${host}`;
  const direct = await tryIcon(`${origin}/favicon.ico`);
  if (direct) return direct;
  try {
    const page = await fetchLimited(`${origin}/`, { timeoutMs: 6000, maxBytes: 512 * 1024, accept: 'text/html' });
    for (const href of iconHrefsFromHtml(page.body.toString('utf8'), page.url || origin).slice(0, 3)) {
      const icon = await tryIcon(href);
      if (icon) return icon;
    }
  } catch {
    /* sin icono */
  }
  return null;
}

const inFlight = new Map<string, Promise<Icon | null>>();

/** Devuelve el favicon cacheado o lo descarga (una vez por dominio a la vez). */
export async function getFavicon(db: DatabaseSync, host: string): Promise<Icon | null> {
  const row = db.prepare('SELECT mime, data, fetched_at FROM favicons WHERE host = ?').get(host) as
    | { mime: string | null; data: Uint8Array | null; fetched_at: string }
    | undefined;
  const age = row ? Date.now() - Date.parse(row.fetched_at) : Infinity;
  if (row?.mime && row.data && age < REFRESH_MS) return { mime: row.mime, data: Buffer.from(row.data) };
  if (row && !row.data && age < RETRY_MS) return null;

  let job = inFlight.get(host);
  if (!job) {
    job = discover(host).finally(() => inFlight.delete(host));
    inFlight.set(host, job);
  }
  const icon = await job;
  db.prepare(
    `INSERT INTO favicons (host, mime, data, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET mime = excluded.mime, data = excluded.data, fetched_at = excluded.fetched_at`,
  ).run(host, icon?.mime ?? null, icon?.data ?? null, new Date().toISOString());
  return icon;
}
