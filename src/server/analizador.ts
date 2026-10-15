// Lógica pura de análisis de páginas HTML: metadatos y propuesta de etiquetas.
// Sin red ni base de datos; expresiones regulares y TextDecoder.

const STOPWORDS = new Set<string>([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'con', 'por', 'para',
  'que', 'del', 'al', 'se', 'su', 'sus', 'como', 'más', 'mas', 'the', 'and', 'for',
  'with', 'that', 'this', 'from', 'your', 'are', 'you', 'our', 'was', 'has', 'have',
  'not', 'but', 'all', 'can', 'will', 'more', 'about', 'home', 'page', 'welcome',
  'inicio', 'bienvenido', 'bienvenida'
]);

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const STOPWORDS_KEYS = new Set<string>([...STOPWORDS].map((w) => stripAccents(w).toLowerCase()));

function isStopword(word: string): boolean {
  const w = word.toLowerCase();
  return STOPWORDS.has(w) || STOPWORDS_KEYS.has(stripAccents(w));
}

// ---------- decodificarHtml ----------

function charsetFromContentType(contentType: string): string | null {
  const m = /charset\s*=\s*["']?([^"'\s;]+)/i.exec(contentType || '');
  return m ? m[1].trim() : null;
}

function attrValue(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

function charsetFromMeta(sample: string): string | null {
  for (const m of sample.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const http = (attrValue(tag, 'http-equiv') || '').toLowerCase();
    if (http === 'content-type') {
      const content = attrValue(tag, 'content') || '';
      const cm = /charset\s*=\s*["']?([^"'\s;]+)/i.exec(content);
      if (cm) return cm[1].trim();
    }
    const c = attrValue(tag, 'charset');
    if (c) return c.trim();
  }
  return null;
}

export function decodificarHtml(cuerpo: Buffer, contentType: string): string {
  let charset = charsetFromContentType(contentType);
  if (!charset) {
    const sample = cuerpo.subarray(0, 2048).toString('latin1');
    charset = charsetFromMeta(sample);
  }
  if (!charset) charset = 'utf-8';
  try {
    return new TextDecoder(charset).decode(cuerpo);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(cuerpo);
    } catch {
      return cuerpo.toString('utf8');
    }
  }
}

// ---------- entidades HTML ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  Ntilde: 'Ñ', Uuml: 'Ü', iexcl: '¡', iquest: '¿',
  Aacute2: 'Á'
};

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const n = parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (body.startsWith('#')) {
      const n = parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    return whole;
  });
}

// ---------- extraerMeta ----------

export interface Meta {
  titulo: string;
  descripcion: string;
  palabrasClave: string[];
  etiquetasArticulo: string[];
  tipo: string;
  nombreSitio: string;
  idioma: string;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function extraerMeta(html: string): Meta {
  const empty: Meta = { titulo: '', descripcion: '', palabrasClave: [], etiquetasArticulo: [], tipo: '', nombreSitio: '', idioma: '' };
  try {
    let h = String(html ?? '');
    // eliminar comentarios y bloques peligrosos
    h = h.replace(/<!--[\s\S]*?-->/g, '');
    h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    h = h.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    h = h.replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '');
    // también por si quedan abiertos (eliminar resto)
    // solo primeros 128 KB
    if (h.length > 128 * 1024) h = h.slice(0, 128 * 1024);
    const headIdx = h.search(/<\/head\s*>/i);
    if (headIdx >= 0) h = h.slice(0, headIdx);

    const metas: { name: string; property: string; content: string }[] = [];
    for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
      metas.push({
        name: (attrValue(m[0], 'name') || '').toLowerCase(),
        property: (attrValue(m[0], 'property') || '').toLowerCase(),
        content: attrValue(m[0], 'content') ?? ''
      });
    }

    // título
    let tituloRaw = '';
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(h);
    if (titleMatch) tituloRaw = titleMatch[1];
    else {
      const og = metas.find((m) => (m.property || m.name) === 'og:title');
      if (og) tituloRaw = og.content;
      else {
        const tw = metas.find((m) => (m.property || m.name) === 'twitter:title');
        if (tw) tituloRaw = tw.content;
      }
    }

    // descripción
    let descRaw = '';
    const descMeta = metas.find((m) => m.name === 'description');
    if (descMeta) descRaw = descMeta.content;
    else {
      const ogd = metas.find((m) => (m.property || m.name) === 'og:description');
      if (ogd) descRaw = ogd.content;
      else {
        const twd = metas.find((m) => (m.property || m.name) === 'twitter:description');
        if (twd) descRaw = twd.content;
      }
    }

    // palabras clave
    const kwMeta = metas.find((m) => m.name === 'keywords' || m.property === 'keywords');
    let palabrasClave: string[] = [];
    if (kwMeta) {
      palabrasClave = kwMeta.content
        .split(/[;,]/)
        .map((s) => collapseWhitespace(decodeEntities(s)))
        .filter((s) => s.length > 0)
        .slice(0, 20);
    }

    // etiquetas artículo
    const etiquetasArticulo: string[] = [];
    for (const m of metas) {
      if (m.property === 'article:tag' || m.name === 'article:tag') {
        const v = collapseWhitespace(decodeEntities(m.content));
        if (v) etiquetasArticulo.push(v);
        if (etiquetasArticulo.length >= 20) break;
      }
    }

    const ogType = metas.find((m) => (m.property || m.name) === 'og:type');
    const ogSite = metas.find((m) => (m.property || m.name) === 'og:site_name');

    // idioma
    const htmlTag = /<html\b[^>]*>/i.exec(h);
    let idioma = '';
    if (htmlTag) {
      const lang = attrValue(htmlTag[0], 'lang');
      if (lang) idioma = lang.trim().toLowerCase().split('-')[0] || '';
    }

    return {
      titulo: collapseWhitespace(decodeEntities(tituloRaw)).slice(0, 300),
      descripcion: collapseWhitespace(decodeEntities(descRaw)).slice(0, 500),
      palabrasClave,
      etiquetasArticulo: etiquetasArticulo.slice(0, 20),
      tipo: (ogType?.content || '').trim().toLowerCase(),
      nombreSitio: collapseWhitespace(decodeEntities(ogSite?.content || '')),
      idioma
    };
  } catch {
    return empty;
  }
}

// ---------- normalizarEtiqueta ----------

export function normalizarEtiqueta(texto: string): string | null {
  try {
    let t = String(texto ?? '').trim().toLowerCase();
    t = t.replace(/^#+/, '');
    t = t.replace(/['"`´‘’“”«»]/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length < 2 || t.length > 30) return null;
    const words = t.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 3) return null;
    if (!/^[\p{L}\p{N} .-]+$/u.test(t)) return null;
    if (words.length === 1 && isStopword(words[0])) return null;
    return t;
  } catch {
    return null;
  }
}

// ---------- claveEtiqueta ----------

export function claveEtiqueta(texto: string): string {
  try {
    return String(texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  } catch {
    return String(texto ?? '').toLowerCase().trim();
  }
}

// ---------- proponerEtiquetas ----------

export interface DatosPropuesta {
  host: string;
  ruta?: string;
  meta: ReturnType<typeof extraerMeta>;
  usadas: string[];
}

function tokenize(hay: string): string[] {
  try {
    return (hay || '').match(/[\p{L}\p{N}]+/gu) || [];
  } catch {
    return [];
  }
}

function cleanUserTag(s: string): string {
  let t = String(s ?? '').trim();
  t = t.replace(/^#+/, '');
  t = t.replace(/['"`´‘’“”«»]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function phraseIn(fieldTokens: string[], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0) return false;
  if (phraseTokens.length > fieldTokens.length) return false;
  outer: for (let i = 0; i <= fieldTokens.length - phraseTokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (fieldTokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

export function proponerEtiquetas(datos: DatosPropuesta): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  try {
    const hostRaw = String(datos?.host ?? '');
    const host = hostRaw.toLowerCase().replace(/^www\./, '');
    const ruta = String(datos?.ruta ?? '');
    const meta = (datos?.meta ?? {}) as ReturnType<typeof extraerMeta>;
    const usadas = Array.isArray(datos?.usadas) ? datos.usadas : [];
    const title = meta.titulo || '';
    const desc = meta.descripcion || '';
    const keywords = Array.isArray(meta.palabrasClave) ? meta.palabrasClave : [];
    const articleTags = Array.isArray(meta.etiquetasArticulo) ? meta.etiquetasArticulo : [];
    const tipo = String(meta.tipo || '').toLowerCase();

    const tryAdd = (rawValue: string, forceExact?: boolean): boolean => {
      if (out.length >= 8) return false;
      const normalized = normalizarEtiqueta(rawValue);
      if (!normalized) return false;
      const key = claveEtiqueta(normalized);
      if (seen.has(key)) return false;
      seen.add(key);
      if (forceExact) out.push(rawValue);
      else out.push(normalized);
      return true;
    };

    // (a) etiquetas del usuario que coincidan
    const pageTermKeys = new Set<string>();
    for (const k of [...keywords, ...articleTags]) pageTermKeys.add(claveEtiqueta(k));
    const titleTokens = tokenize(title).map((t) => t.toLowerCase());
    const descTokens = tokenize(desc).map((t) => t.toLowerCase());
    for (const w of titleTokens) pageTermKeys.add(claveEtiqueta(w));
    for (const w of descTokens) pageTermKeys.add(claveEtiqueta(w));
    pageTermKeys.add(claveEtiqueta(title));
    pageTermKeys.add(claveEtiqueta(desc));
    const hostParts = host.split(/[.-]/).filter(Boolean);
    const withoutTld = hostParts.length > 1 ? hostParts.slice(0, -1) : hostParts;
    for (const p of withoutTld) pageTermKeys.add(claveEtiqueta(p));

    for (const u of usadas) {
      if (out.length >= 8) break;
      const cleaned = cleanUserTag(String(u));
      const normalized = normalizarEtiqueta(cleaned);
      if (!normalized) continue;
      const key = claveEtiqueta(normalized);
      // calificar
      let qualifies = pageTermKeys.has(key);
      if (!qualifies) {
        const userTokens = tokenize(cleaned).map((t) => t.toLowerCase());
        const titleTokensKey = titleTokens.map((t) => claveEtiqueta(t));
        const userTokensKey = userTokens.map((t) => claveEtiqueta(t));
        const descTokensKey = descTokens.map((t) => claveEtiqueta(t));
        if (phraseIn(titleTokensKey, userTokensKey) || phraseIn(descTokensKey, userTokensKey)) qualifies = true;
      }
      if (!qualifies) continue;
      // añadir con grafía exacta del usuario (limpia, conservando mayúsculas)
      tryAdd(cleaned, true);
    }

    // (b) palabrasClave y etiquetasArticulo máx 5
    let countB = 0;
    for (const v of [...keywords, ...articleTags]) {
      if (out.length >= 8) break;
      if (countB >= 5) break;
      if (tryAdd(v, false)) countB++;
    }

    // (c) reglas por dominio
    if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') {
      tryAdd('git', false);
      tryAdd('código', false);
    }
    if (host === 'stackoverflow.com') {
      tryAdd('programación', false);
    }
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'vimeo.com') {
      tryAdd('vídeo', false);
    }
    if (host === 'wikipedia.org' || host.endsWith('.wikipedia.org')) {
      tryAdd('enciclopedia', false);
    }
    if (host.startsWith('docs.') || ruta.toLowerCase().startsWith('/docs')) {
      tryAdd('documentación', false);
    }
    if (host.startsWith('wiki.')) {
      tryAdd('wiki', false);
    }
    if (host.startsWith('panel.') || host.startsWith('admin.') || host.startsWith('cpanel.')) {
      tryAdd('panel', false);
    }
    if (host.startsWith('status.') || host.startsWith('estado.')) {
      tryAdd('monitor', false);
    }
    if (host.startsWith('api.')) {
      tryAdd('api', false);
    }
    if (host.startsWith('mail.') || host.startsWith('correo.') || host.startsWith('webmail.')) {
      tryAdd('correo', false);
    }

    // (d) tipo
    if (tipo === 'video' || tipo.startsWith('video.')) tryAdd('vídeo', false);
    if (tipo === 'article') tryAdd('artículo', false);

    // (e) palabras frecuentes
    const counts = new Map<string, number>();
    const firstIndex = new Map<string, number>();
    const inTitleSet = new Set<string>(titleTokens.map((t) => t.toLowerCase()));
    let idx = 0;
    for (const w of [...titleTokens, ...descTokens]) {
      const lw = w.toLowerCase();
      if (!counts.has(lw)) firstIndex.set(lw, idx++);
      counts.set(lw, (counts.get(lw) || 0) + 1);
    }
    const freqCands = [...counts.entries()]
      .filter(([w, c]) => {
        if (w.length < 4) return false;
        if (isStopword(w)) return false;
        if (!normalizarEtiqueta(w)) return false;
        return c >= 2 || inTitleSet.has(w);
      })
      .sort((a, b) => b[1] - a[1] || (firstIndex.get(a[0])! - firstIndex.get(b[0])!))
      .slice(0, 3)
      .map(([w]) => w);

    for (const w of freqCands) {
      if (out.length >= 8) break;
      tryAdd(w, false);
    }

    return out.slice(0, 8);
  } catch {
    return out.slice(0, 8);
  }
}
