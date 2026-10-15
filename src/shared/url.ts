/**
 * Valida y normaliza una URL introducida por el usuario.
 * Solo se aceptan http y https: cualquier otro esquema (javascript:, data:, file:…)
 * se rechaza para que un enlace nunca pueda ejecutar código.
 * Si falta el esquema se asume https.
 */
export function normalizeUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  // «servidor:8080/ruta» es host y puerto, no un esquema.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[a-z0-9.-]+:\d+(\/|$)/i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url.href;
}

/** Dominio visible de una URL, sin «www.». */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Clave para detectar duplicados: ignora esquema, «www.», mayúsculas del dominio,
 * barra final, fragmento y el orden de los parámetros.
 */
export function duplicateKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '');
    const params = [...u.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${host}${port}${path}${params ? `?${params}` : ''}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Convierte un texto «a, b ,c» en etiquetas limpias y sin repetir. */
export function parseTags(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const tag = String(p).trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out.slice(0, 20);
}
