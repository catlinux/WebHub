/** Peticiones salientes con tiempo límite y tamaño máximo (favicons y comprobador). */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) WebHub/0.1 (+directorio personal de enlaces)';

export async function fetchLimited(
  url: string,
  opts: { method?: string; timeoutMs?: number; maxBytes?: number; accept?: string } = {},
): Promise<{ status: number; url: string; contentType: string; body: Buffer }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: opts.accept ?? '*/*' },
    });
    const max = opts.maxBytes ?? 0;
    const chunks: Buffer[] = [];
    let size = 0;
    if (max > 0 && res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        size += value.length;
        chunks.push(Buffer.from(value));
        if (size >= max) break;
      }
      void reader.cancel().catch(() => {});
    }
    ctrl.abort(); // no descargamos el resto
    return { status: res.status, url: res.url, contentType: res.headers.get('content-type') ?? '', body: max > 0 ? Buffer.concat(chunks).subarray(0, max) : Buffer.alloc(0) };
  } finally {
    clearTimeout(timer);
  }
}

/** Traduce un error de red a un estado corto y legible. */
export function describeError(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === 'AbortError') return 'tiempo agotado';
  const code = e?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dominio no encontrado';
  if (code === 'ECONNREFUSED') return 'conexión rechazada';
  if (code.startsWith('CERT_') || code.includes('TLS') || code.includes('SSL') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'error de certificado';
  return code ? `error de red (${code})` : 'error de red';
}
