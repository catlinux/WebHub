import type { Family, Link, Snapshot } from '../shared/types.ts';
import { byPosition } from '../shared/order.ts';
import { rememberHost } from './dom.ts';

export type View =
  | { kind: 'all' }
  | { kind: 'fav' }
  | { kind: 'family'; id: number }
  | { kind: 'admin'; tab: 'organizar' | 'importar' | 'copia' | 'comprobar' | 'aspecto' | 'acceso' };

/** Estado en memoria. Los datos son pocos (cientos de enlaces): se cargan una vez y se indexan. */
export const state = {
  families: [] as Family[],
  links: [] as Link[],
  view: { kind: 'all' } as View,
  query: '',
};

export function load(snapshot: Snapshot): void {
  state.families = snapshot.families.slice().sort(byPosition);
  state.links = snapshot.links.slice().sort(byPosition);
  for (const l of state.links) rememberHost(l.domain, l.url);
}

export const topFamilies = () => state.families.filter((f) => f.parentId === null);
export const childrenOf = (id: number) => state.families.filter((f) => f.parentId === id);
export const familyById = (id: number) => state.families.find((f) => f.id === id);
export const linksOf = (familyId: number) => state.links.filter((l) => l.familyId === familyId);
export const linkById = (id: number) => state.links.find((l) => l.id === id);

/** Enlaces de la familia y de sus subfamilias. */
export function countFamily(id: number): number {
  return linksOf(id).length + childrenOf(id).reduce((n, c) => n + linksOf(c.id).length, 0);
}

export function familyLabel(id: number): string {
  const f = familyById(id);
  if (!f) return '';
  const parent = f.parentId !== null ? familyById(f.parentId) : undefined;
  return parent ? `${parent.name} › ${f.name}` : f.name;
}

/** Favoritos y más usados: los marcados primero, después los más clicados. */
export function favorites(): { starred: Link[]; top: Link[] } {
  const starred = state.links.filter((l) => l.favorite);
  const top = state.links
    .filter((l) => l.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks || (b.lastClickAt ?? '').localeCompare(a.lastClickAt ?? ''))
    .slice(0, 40);
  return { starred, top };
}

export function parseHash(hash: string): View {
  const parts = hash.replace(/^#\/?/, '').split('/');
  switch (parts[0]) {
    case 'favoritos':
      return { kind: 'fav' };
    case 'f': {
      const id = Number(parts[1]);
      return familyById(id) ? { kind: 'family', id } : { kind: 'all' };
    }
    case 'admin': {
      const tab = parts[1];
      return { kind: 'admin', tab: tab === 'importar' || tab === 'copia' || tab === 'comprobar' || tab === 'aspecto' || tab === 'acceso' ? tab : 'organizar' };
    }
    default:
      return { kind: 'all' };
  }
}

export function viewHash(view: View): string {
  switch (view.kind) {
    case 'all': return '#/todos';
    case 'fav': return '#/favoritos';
    case 'family': return `#/f/${view.id}`;
    case 'admin': return view.tab === 'organizar' ? '#/admin' : `#/admin/${view.tab}`;
  }
}
