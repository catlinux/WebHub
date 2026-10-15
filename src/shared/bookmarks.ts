import { domainOf, duplicateKey, normalizeUrl } from './url.ts';

/** Carpeta del archivo de marcadores tal como viene del navegador. */
export interface BookmarkFolder {
  name: string;
  toolbar: boolean;
  folders: BookmarkFolder[];
  links: BookmarkLink[];
}

export interface BookmarkLink {
  title: string;
  href: string;
  note: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function attr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/**
 * Lee un archivo HTML de exportación de marcadores (formato «Netscape Bookmark»,
 * el que generan Chrome, Edge, Firefox, Brave…). Es tolerante: no exige HTML válido,
 * solo sigue las etiquetas <DT><H3>, <DL>, </DL>, <DT><A> y <DD>.
 */
export function parseBookmarksHtml(html: string): BookmarkFolder {
  const root: BookmarkFolder = { name: '', toolbar: false, folders: [], links: [] };
  const stack: BookmarkFolder[] = [];
  let pending: BookmarkFolder | null = null;
  let lastLink: BookmarkLink | null = null;

  const token = /<h3([^>]*)>([\s\S]*?)<\/h3>|<dl[^>]*>|<\/dl>|<a\s([^>]*)>([\s\S]*?)<\/a>|<dd>([^<]*)/gi;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    const tag = m[0].slice(0, 3).toLowerCase();
    if (m[2] !== undefined) {
      // Carpeta: se abre de verdad en el <DL> siguiente.
      pending = { name: clean(m[2]) || 'Sin nombre', toolbar: /personal_toolbar_folder\s*=\s*"?true/i.test(m[1] ?? ''), folders: [], links: [] };
      lastLink = null;
    } else if (tag === '<dl') {
      if (stack.length === 0) {
        stack.push(root);
      } else {
        const folder = pending ?? { name: 'Sin nombre', toolbar: false, folders: [], links: [] };
        (stack[stack.length - 1] as BookmarkFolder).folders.push(folder);
        stack.push(folder);
      }
      pending = null;
      lastLink = null;
    } else if (tag === '</d') {
      if (stack.length > 1) stack.pop();
      lastLink = null;
    } else if (m[3] !== undefined) {
      const link = { title: clean(m[4] ?? ''), href: attr(m[3], 'href'), note: '' };
      (stack[stack.length - 1] ?? root).links.push(link);
      lastLink = link;
    } else if (m[5] !== undefined && lastLink) {
      lastLink.note = clean(m[5]).slice(0, 500);
      lastLink = null;
    }
  }
  return root;
}

/** Nombres de las carpetas contenedoras que crean los navegadores. */
const CONTAINERS = [
  'bookmarks bar', 'barra de marcadores', 'barra de favoritos', 'favorites bar',
  'other bookmarks', 'otros marcadores', 'otros favoritos', 'other favorites',
  'mobile bookmarks', 'marcadores del móvil', 'marcadores de móvil', 'favoritos del móvil',
  'bookmarks toolbar', 'barra de herramientas de marcadores',
  'bookmarks menu', 'menú de marcadores',
];

export function isContainerFolder(folder: BookmarkFolder): boolean {
  return folder.toolbar || CONTAINERS.includes(folder.name.trim().toLowerCase());
}

export type DuplicateKind = 'existing' | 'inFile' | null;

export interface PlanLink {
  title: string;
  url: string;
  domain: string;
  note: string;
  duplicate: DuplicateKind;
}

export interface PlanGroup {
  /** Identificador estable dentro del plan (ruta de carpetas). */
  key: string;
  name: string;
  parentKey: string | null;
  /** Si ya existe una familia con ese nombre en el mismo nivel, se reutiliza. */
  existingFamilyId: number | null;
  links: PlanLink[];
}

export interface ImportPlan {
  groups: PlanGroup[];
  totalLinks: number;
  duplicates: number;
  /** Enlaces descartados por no ser http/https (javascript:, place:, chrome://…). */
  invalid: number;
}

export interface PlanOptions {
  existingUrls: readonly string[];
  existingFamilies: readonly { id: number; name: string; parentId: number | null }[];
  /** Si es true, el contenido de «Barra de marcadores», «Otros marcadores»… sube un nivel. */
  unwrapContainers: boolean;
}

const LOOSE_NAME = 'Importados';

/**
 * Convierte el árbol de marcadores en un plan de importación de dos niveles
 * (familias y subfamilias). Las carpetas más profundas se aplanan como
 * subfamilias con nombre compuesto «B / C». Marca los duplicados.
 */
export function planImport(root: BookmarkFolder, options: PlanOptions): ImportPlan {
  const existing = new Set(options.existingUrls.map(duplicateKey));
  const seenInFile = new Set<string>();
  const groups = new Map<string, PlanGroup>();
  let invalid = 0;
  let duplicates = 0;
  let total = 0;

  const findFamily = (name: string, parentId: number | null): number | null => {
    const n = name.trim().toLowerCase();
    const f = options.existingFamilies.find((x) => x.parentId === parentId && x.name.trim().toLowerCase() === n);
    return f ? f.id : null;
  };

  const groupFor = (path: string[]): PlanGroup => {
    const top = path[0] as string;
    const topKey = top.toLowerCase();
    let topGroup = groups.get(topKey);
    if (!topGroup) {
      topGroup = { key: topKey, name: top, parentKey: null, existingFamilyId: findFamily(top, null), links: [] };
      groups.set(topKey, topGroup);
    }
    if (path.length === 1) return topGroup;
    const subName = path.slice(1).join(' / ');
    const subKey = `${topKey}/${subName.toLowerCase()}`;
    let sub = groups.get(subKey);
    if (!sub) {
      const parentId = topGroup.existingFamilyId;
      sub = {
        key: subKey,
        name: subName,
        parentKey: topKey,
        existingFamilyId: parentId === null ? null : findFamily(subName, parentId),
        links: [],
      };
      groups.set(subKey, sub);
    }
    return sub;
  };

  const addLinks = (links: BookmarkLink[], path: string[]) => {
    for (const l of links) {
      const url = normalizeUrl(l.href);
      if (!url || !/^https?:/i.test(l.href.trim())) {
        invalid++;
        continue;
      }
      const key = duplicateKey(url);
      let duplicate: DuplicateKind = null;
      if (existing.has(key)) duplicate = 'existing';
      else if (seenInFile.has(key)) duplicate = 'inFile';
      seenInFile.add(key);
      if (duplicate) duplicates++;
      total++;
      groupFor(path).links.push({
        title: (l.title || domainOf(url) || url).slice(0, 300),
        url,
        domain: domainOf(url),
        note: l.note,
        duplicate,
      });
    }
  };

  const walk = (folder: BookmarkFolder, path: string[]) => {
    addLinks(folder.links, path.length ? path : [LOOSE_NAME]);
    for (const f of folder.folders) walk(f, [...path, f.name]);
  };

  addLinks(root.links, [LOOSE_NAME]);
  for (const folder of root.folders) {
    if (options.unwrapContainers && isContainerFolder(folder)) {
      addLinks(folder.links, [folder.name]);
      for (const f of folder.folders) walk(f, [f.name]);
    } else {
      walk(folder, [folder.name]);
    }
  }

  // Quita grupos vacíos que no tengan subgrupos con enlaces.
  const list = [...groups.values()];
  const used = list.filter((g) => g.links.length > 0 || list.some((c) => c.parentKey === g.key && c.links.length > 0));
  return { groups: used, totalLinks: total, duplicates, invalid };
}
