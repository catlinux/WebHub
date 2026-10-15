/** Peticiones salientes con tiempo límite y tamaño máximo (favicons y comprobador). */

import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns';
import * as net from 'node:net';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) WebHub/0.1 (+directorio personal de enlaces)';

let permisoPrivadas: boolean | string[] = false;

/** Solo para pruebas: permite o no redes privadas en las peticiones salientes. */
export function permitirRedesPrivadas(permitidos: boolean | string[]): void {
  permisoPrivadas = permitidos;
}

export class RedInternaError extends Error {
  constructor(message = 'red interna') {
    super(message);
    this.name = 'RedInternaError';
  }
}

function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

export function esDireccionInterna(ip: string): boolean {
  if (typeof ip !== 'string' || ip === '') return true;
  const trimmed = ip.trim();
  if (trimmed === '') return true;
  // IPv6 (admite zona y corchetes de forma laxa).
  if (net.isIP(trimmed) === 6) {
    const words = parseIpv6Words(trimmed.replace(/^\[/, '').replace(/\]$/, ''));
    if (!words) return true;
    // :: (todo cero)
    if (words.every((w) => w === 0)) return true;
    // ::1
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 &&
        words[4] === 0 && words[5] === 0 && words[6] === 0 && words[7] === 1) return true;
    // fc00::/7
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10
    if ((words[0] & 0xffc0) === 0xfe80) return true;
    // fec0::/10 (site-local, en desuso)
    if ((words[0] & 0xffc0) === 0xfec0) return true;
    // ff00::/8
    if ((words[0] & 0xff00) === 0xff00) return true;
    // 2001:db8::/32
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
    // ::/96 (IPv4 compatible, en desuso: ::127.0.0.1), 2002::/16 (6to4) y 2001::/32 (Teredo) llevan una IPv4 dentro
    if (words.slice(0, 6).every((w) => w === 0)) return true;
    if (words[0] === 0x2002) return true;
    if (words[0] === 0x2001 && words[1] === 0) return true;
    // 100::/64
    if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) return true;
    // IPv4 mapeadas ::ffff:a.b.c.d
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 &&
        words[4] === 0 && words[5] === 0xffff) {
      const ip4 = wordsToIpv4(words[6], words[7]);
      return esDireccionInterna(ip4);
    }
    // NAT64 64:ff9b::/96
    if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 &&
        words[4] === 0 && words[5] === 0) {
      const ip4 = wordsToIpv4(words[6], words[7]);
      return esDireccionInterna(ip4);
    }
    return false;
  }

  if (net.isIP(trimmed) !== 4) return true;
  const parts = trimmed.split('.');
  if (parts.length !== 4) return true;
  const o = parts.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c, d] = o as [number, number, number, number];
  const first = a;
  if (first === 0) return true; // 0.0.0.0/8
  if (first === 10) return true; // 10.0.0.0/8
  if (first === 127) return true; // 127.0.0.0/8
  if (first === 169 && b === 254) return true; // 169.254.0.0/16
  if (first === 192 && b === 168) return true; // 192.168.0.0/16
  if (first >= 224 && first <= 239) return true; // 224.0.0.0/4
  if (first >= 240 && first <= 255) return true; // 240.0.0.0/4
  if (first === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (first === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (first === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (first === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (first === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (first === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (first === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  return false;
}

function wordsToIpv4(high: number, low: number): string {
  const n = ((high << 16) >>> 0) + low;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function parseIpv6Words(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  let v4tail: number[] | null = null;
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    if (idx === -1) return null;
    const v4 = s.slice(idx + 1);
    if (net.isIP(v4) !== 4) return null;
    const octs = v4.split('.').map((x) => Number(x));
    if (octs.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    v4tail = [(octs[0]! * 256 + octs[1]!), (octs[2]! * 256 + octs[3]!)];
    s = s.slice(0, idx);
  }
  const hexGroup = (g: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    return parseInt(g, 16);
  };
  const hasDouble = s.includes('::');
  if (hasDouble && s.indexOf('::') !== s.lastIndexOf('::')) return null;

  let words: number[] = [];
  if (hasDouble) {
    const [leftRaw, rightRaw] = s.split('::');
    const left = leftRaw === '' ? [] : leftRaw.split(':');
    const right = rightRaw === '' ? [] : rightRaw.split(':');
    if (left.some((g) => g === '' || hexGroup(g) === null)) return null;
    if (right.some((g) => g === '' || hexGroup(g) === null)) return null;
    const leftWords = left.map((g) => hexGroup(g)!);
    const rightWords = right.map((g) => hexGroup(g)!);
    const tailLen = v4tail ? 2 : 0;
    const fill = 8 - (leftWords.length + rightWords.length + tailLen);
    if (fill < 0) return null;
    words = [...leftWords, ...Array(fill).fill(0), ...rightWords, ...(v4tail ?? [])];
  } else {
    const groups = s === '' ? [] : s.split(':');
    if (groups.some((g) => g === '' || hexGroup(g) === null)) return null;
    const headWords = groups.map((g) => hexGroup(g)!);
    const tailLen = v4tail ? 2 : 0;
    if (headWords.length + tailLen !== 8) return null;
    words = [...headWords, ...(v4tail ?? [])];
  }
  if (words.length !== 8) return null;
  return words;
}

function destinoPermitido(host: string, port: number): boolean {
  if (permisoPrivadas === true) return true;
  if (Array.isArray(permisoPrivadas)) {
    return permisoPrivadas.includes(`${host}:${port}`);
  }
  return false;
}

// Implementación flexible del lookup estilo Node.
export function lookupSeguro(...args: any[]): any {
  // Determinar opciones/callback/resolutor.
  let host: string = String(args[0]);
  let options: any = {};
  let callback: ((...r: any[]) => void) | null = null;
  let resolverOverride: any = null;
  if (typeof options?.resolver === 'function' && !resolverOverride) {
    resolverOverride = options.resolver;
  }
  for (let i = 1; i < args.length; i++) {
    const v = args[i];
    if (v && typeof v === 'object' && typeof v !== 'function') {
      options = { ...options, ...(v as object) };
    } else if (typeof v === 'number') {
      if (!options || typeof options !== 'object') options = {};
      (options as any).family = (options as any).family ?? v;
    } else if (typeof v === 'function') {
      const fn = v as any;
      // Un resolutor estilo dns.lookup tiene 3 parámetros; un callback, 1 o 2.
      if (fn.length >= 3 && resolverOverride === null) {
        resolverOverride = fn;
      } else if (callback === null) {
        callback = fn;
      } else if (resolverOverride === null) {
        resolverOverride = fn;
      }
    }
  }
  if (typeof options?.resolver === 'function') resolverOverride = options.resolver;
  const resolver = resolverOverride ?? dns.lookup;

  const run = (cb: (err: any, ...r: any[]) => void) => {
    const hostClean = host.replace(/^\[/, '').replace(/\]$/, '');
    // Literal IP: comprobar antes de resolver.
    if (net.isIP(hostClean) === 4 || net.isIP(hostClean) === 6) {
      if (esDireccionInterna(hostClean) && !destinoPermitido(hostClean, -1)) {
        // El puerto aún no se conoce aquí; la comprobación fina va en fetchLimited.
        // Para mantener el gancho, si el destino es interna se bloquea por defecto.
      }
    }
    // Si es IP literal, no hace falta resolver.
    if (net.isIP(hostClean) > 0) {
      if (esDireccionInterna(hostClean)) {
        // Permitir si está en la lista (independientemente del puerto desconocido se decide en fetchLimited;
        // aquí, por compatibilidad, no bloqueamos los destinos explícitamente permitidos por host).
        const allowedByHost = permisoPrivadas === true ||
          (Array.isArray(permisoPrivadas) && permisoPrivadas.some((x) => x.split(':')[0] === hostClean));
        if (!allowedByHost) {
          cb(new RedInternaError('red interna'));
          return;
        }
      }
      const fam = net.isIP(hostClean);
      const entry = { address: hostClean, family: fam };
      if (options?.all) cb(null, [entry]);
      else cb(null, hostClean, fam);
      return;
    }

    resolver(host, { all: true, ...(options?.family ? { family: options.family } : {}) }, (err: any, addresses: any) => {
      if (err) { cb(err); return; }
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const entries = list
        .map((a: any) => typeof a === 'string' ? { address: a, family: net.isIP(a) } : a)
        .filter((a: any) => a && a.address);
      if (entries.some((a: any) => esDireccionInterna(a.address))) {
        cb(new RedInternaError('red interna'));
        return;
      }
      if (options?.all) cb(null, entries);
      else {
        const first = entries[0];
        cb(null, first.address, first.family);
      }
    });
  };

  if (typeof callback === 'function') {
    run(callback);
    return;
  }
  // Sin callback: devolver promesa.
  return new Promise((resolve, reject) => {
    run((err, ...rest) => {
      if (err) reject(err);
      else resolve(rest.length <= 1 ? rest[0] : rest);
    });
  });
}

interface FetchResult { status: number; url: string; contentType: string; body: Buffer; location: string }

function wrapError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const src: any = err;
  const code = src?.code ?? src?.cause?.code;
  if (code && !(e as any).cause?.code) {
    (e as any).cause = { code };
  }
  if (src?.name && e.name !== 'AbortError') e.name = src.name;
  // Preservar AbortError.
  if (src?.name === 'AbortError') e.name = 'AbortError';
  return e;
}

function doRequestOnce(current: URL, opts: { method?: string; timeoutMs?: number; maxBytes?: number; accept?: string }): Promise<FetchResult> {
  return new Promise<FetchResult>((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const method = (opts.method ?? 'GET').toUpperCase();
    const max = opts.maxBytes ?? 0;
    const accept = opts.accept ?? '*/*';
    const lib = current.protocol === 'https:' ? https : http;
    const port = current.port ? Number(current.port) : (current.protocol === 'https:' ? 443 : 80);
    const hostClean = current.hostname.replace(/^\[/, '').replace(/\]$/, '');

    // Literal IP interna: bloquear antes de conectar (salvo destinos permitidos).
    if (net.isIP(hostClean) > 0 && esDireccionInterna(hostClean)) {
      const allowed = destinoPermitido(hostClean, port);
      if (!allowed) {
        reject(new RedInternaError('red interna'));
        return;
      }
    }

    const lookupFn = (permisoPrivadas === true)
      ? dns.lookup
      : (Array.isArray(permisoPrivadas) && permisoPrivadas.includes(`${hostClean}:${port}`))
        ? dns.lookup
        : lookupSeguro;

    let settled = false;
    let intentional = false;
    let timer: NodeJS.Timeout | null = null;
    const req = lib.request(current, {
      method,
      agent: false,
      lookup: lookupFn as any,
      headers: { 'User-Agent': UA, Accept: accept },
    });

    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(wrapError(err));
    };
    const finishResolve = (r: FetchResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };

    req.on('error', (err: any) => {
      if (intentional) return;
      finishReject(err);
    });

    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      const contentType = (res.headers['content-type'] ?? '').toString();
      const location = (res.headers['location'] ?? '').toString();
      const chunks: Buffer[] = [];
      let size = 0;

      const finalize = () => {
        const body = max > 0 ? Buffer.concat(chunks).subarray(0, max) : Buffer.alloc(0);
        finishResolve({ status, url: current.href, contentType, body, location });
      };

      res.on('data', (chunk: Buffer) => {
        if (max <= 0) {
          if (!intentional) { intentional = true; res.destroy(); }
          return;
        }
        size += chunk.length;
        if (size <= max) {
          chunks.push(Buffer.from(chunk));
        } else {
          const already = size - chunk.length;
          const remain = max - already;
          if (remain > 0) chunks.push(Buffer.from(chunk.subarray(0, remain)));
          if (!intentional) { intentional = true; res.destroy(); }
        }
      });
      res.on('end', () => finalize());
      res.on('close', () => {
        if (!settled) finalize();
      });
      res.on('error', (err: any) => {
        if (intentional) { if (!settled) finalize(); return; }
        finishReject(err);
      });
    });

    timer = setTimeout(() => {
      const abortErr: any = new Error('tiempo agotado');
      abortErr.name = 'AbortError';
      intentional = false;
      try { req.destroy(abortErr); } catch {}
      finishReject(abortErr);
    }, timeoutMs);

    req.end();
  });
}

export async function fetchLimited(
  url: string,
  opts: { method?: string; timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<{ status: number; url: string; contentType: string; body: Buffer }> {
  const method = opts.method ?? 'GET';
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error('URL inválida');
  }
  // Protocolo inicial.
  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    throw new Error('solo se permiten protocolos http y https');
  }

  let redirects = 0;
  for (;;) {
    const res = await doRequestOnce(current, { ...opts, method });
    const status = res.status;
    const isRedirect = status >= 300 && status < 400 && !!res.location;
    if (isRedirect) {
      if (redirects >= 5) {
        throw new Error('demasiadas redirecciones');
      }
      let next: URL;
      try {
        next = new URL(res.location, current);
      } catch {
        throw new Error('Location inválida');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error('solo se permiten protocolos http y https');
      }
      current = next;
      redirects += 1;
      continue;
    }
    return { status: res.status, url: current.href, contentType: res.contentType, body: res.body };
  }
}

export function describeError(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === 'RedInternaError') return 'bloqueado (red interna)';
  if (e?.name === 'AbortError') return 'tiempo agotado';
  const code = e?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dominio no encontrado';
  if (code === 'ECONNREFUSED') return 'conexión rechazada';
  if (code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'error de certificado';
  return code ? `error de red (${code})` : 'error de red';
}