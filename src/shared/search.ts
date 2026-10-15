import type { Link } from './types.ts';

/** Minúsculas y sin tildes, para que «accion» encuentre «Acción». */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

type Searchable = Pick<Link, 'title' | 'domain' | 'note' | 'tags' | 'url'> & { familyName?: string };

/**
 * Puntúa un enlace frente a una consulta. Todos los términos deben aparecer en
 * algún campo (título, dominio, URL, notas, etiquetas o familia); si alguno falta devuelve 0.
 * Pesa más el título (sobre todo al principio de palabra) que el dominio, las etiquetas y las notas.
 */
export function scoreLink(link: Searchable, query: string): number {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const title = fold(link.title);
  const domain = fold(link.domain);
  const url = fold(link.url);
  const note = fold(link.note);
  const tags = link.tags.map(fold);
  const family = fold(link.familyName ?? '');

  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (title.startsWith(term)) best = 100;
    else if (wordStart(title, term)) best = 80;
    else if (title.includes(term)) best = 60;
    if (domain.startsWith(term)) best = Math.max(best, 70);
    else if (domain.includes(term)) best = Math.max(best, 50);
    if (tags.some((t) => t === term)) best = Math.max(best, 55);
    else if (tags.some((t) => t.includes(term))) best = Math.max(best, 40);
    if (family.includes(term)) best = Math.max(best, 25);
    if (note.includes(term)) best = Math.max(best, 20);
    if (url.includes(term)) best = Math.max(best, 15);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function wordStart(text: string, term: string): boolean {
  let i = text.indexOf(term);
  while (i > 0) {
    if (/[^a-z0-9]/.test(text[i - 1] as string)) return true;
    i = text.indexOf(term, i + 1);
  }
  return i === 0;
}

/** Filtra y ordena enlaces por relevancia; a igualdad, los más usados primero. */
export function searchLinks<T extends Searchable & { clicks: number }>(
  links: readonly T[],
  query: string,
  limit = 200,
): T[] {
  if (!query.trim()) return [];
  return links
    .map((link) => ({ link, score: scoreLink(link, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.link.clicks - a.link.clicks || a.link.title.localeCompare(b.link.title))
    .slice(0, limit)
    .map((r) => r.link);
}
