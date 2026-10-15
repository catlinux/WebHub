import { fetchLimited, RedInternaError } from './fetcher.ts';
import { decodificarHtml, extraerMeta, proponerEtiquetas } from './analizador.ts';

export type MotivoAnalisis = 'url' | 'bloqueada' | 'no_html' | 'estado' | 'red' | 'tiempo';

export class ErrorAnalisis extends Error {
  motivo: MotivoAnalisis;
  constructor(motivo: MotivoAnalisis, message: string = motivo) {
    super(message);
    this.name = 'ErrorAnalisis';
    this.motivo = motivo;
  }
}

type OpcionesAnalisis = number | { timeoutMs?: number };

export async function analizarUrl(
  url: unknown,
  usadas: string[] = [],
  opciones?: OpcionesAnalisis,
): Promise<{ titulo: string; descripcion: string; etiquetas: string[] }> {
  const timeoutMs = typeof opciones === 'number' ? opciones : (opciones?.timeoutMs ?? 8000);

  if (typeof url !== 'string' || url.length > 2048) {
    throw new ErrorAnalisis('url', 'URL no válida.');
  }
  let inicial: URL;
  try {
    inicial = new URL(url);
  } catch {
    throw new ErrorAnalisis('url', 'URL no válida.');
  }
  if (inicial.protocol !== 'http:' && inicial.protocol !== 'https:') {
    throw new ErrorAnalisis('url', 'URL no válida.');
  }

  let resultado: { status: number; url: string; contentType: string; body: Buffer };
  try {
    resultado = await fetchLimited(url, {
      method: 'GET',
      timeoutMs,
      maxBytes: 256 * 1024,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    });
  } catch (err) {
    if (err instanceof RedInternaError) throw new ErrorAnalisis('bloqueada', 'No se puede analizar una dirección interna.');
    if ((err as { name?: string })?.name === 'AbortError') throw new ErrorAnalisis('tiempo', 'La página tardó demasiado en responder.');
    throw new ErrorAnalisis('red', 'No se pudo descargar la página.');
  }

  if (resultado.status >= 400) throw new ErrorAnalisis('estado', 'La dirección no devuelve una página web.');
  if (!String(resultado.contentType ?? '').toLowerCase().includes('html')) {
    throw new ErrorAnalisis('no_html', 'La dirección no devuelve una página web.');
  }

  const html = decodificarHtml(resultado.body, resultado.contentType);
  const meta = extraerMeta(html);
  const final = new URL(resultado.url);
  const etiquetas = proponerEtiquetas({
    host: final.hostname,
    ruta: final.pathname,
    meta,
    usadas: Array.isArray(usadas) ? usadas : [],
  });

  return { titulo: meta.titulo, descripcion: meta.descripcion, etiquetas };
}

export class LimitadorAnalisis {
  readonly max: number;
  readonly ventanaMs: number;
  private readonly reloj: () => number;
  private marcas: number[] = [];

  constructor(opts: { max?: number; ventanaMs?: number; reloj?: () => number } = {}) {
    this.max = opts.max ?? 20;
    this.ventanaMs = opts.ventanaMs ?? 60_000;
    this.reloj = opts.reloj ?? Date.now;
  }

  permitir(): boolean {
    const ahora = this.reloj();
    this.marcas = this.marcas.filter((t) => ahora - t < this.ventanaMs);
    if (this.marcas.length < this.max) {
      this.marcas.push(ahora);
      return true;
    }
    return false;
  }
}