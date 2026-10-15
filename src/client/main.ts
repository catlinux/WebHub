import { h, clear, toast, favicon } from './dom.ts';
import { api, sendClick, setUnauthorizedHandler } from './api.ts';
import {
  state, load, topFamilies, childrenOf, familyById, linksOf, linkById, countFamily, familyLabel, favorites, parseHash, viewHash,
  type View,
} from './state.ts';
import { searchLinks } from '../shared/search.ts';
import { linkDialog, familyDialog } from './dialogs.ts';
import { renderAdmin } from './admin.ts';
import { aplicarAspecto } from './aspecto.ts';
import { attachTooltips, hideTooltip } from './tooltip.ts';
import { dropReorder } from '../shared/order.ts';
import type { Family, Link, Snapshot } from '../shared/types.ts';

const root = document.getElementById('app') as HTMLElement;

// ---------------------------------------------------------------- arranque

async function boot(): Promise<void> {
  setUnauthorizedHandler(() => showLogin());
  try {
    const session = await api<{ authenticated: boolean; configured: boolean }>('GET', '/api/session');
    if (!session.authenticated) return showLogin(session.configured);
    await reload();
    buildLayout();
    route();
    window.addEventListener('hashchange', route);
  } catch (err) {
    root.className = 'cargando';
    root.textContent = `No se pudo conectar con el servidor: ${(err as Error).message}`;
  }
}

export async function reload(): Promise<void> {
  load(await api<Snapshot>('GET', '/api/data'));
  if (layout) {
    renderSidebar();
    renderContent();
  }
}

// ---------------------------------------------------------------- login

function showLogin(configured = true): void {
  layout = null;
  window.removeEventListener('hashchange', route);
  root.className = 'login';
  // type=password oculta las cifras; inputmode=numeric saca el teclado numérico en el móvil.
  const input = h('input', {
    class: 'campo pin',
    attrs: { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 12, placeholder: 'PIN', autocomplete: 'current-password', required: true, 'aria-label': 'PIN' },
  });
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    if (digits !== input.value) input.value = digits;
  });
  const error = h('div', { class: 'error', attrs: { role: 'alert' } });
  const button = h('button', { class: 'btn primario', text: 'Entrar', attrs: { type: 'submit' } });
  if (!configured) error.textContent = 'Aún no hay PIN: créalo en el servidor con «npm run pin».';
  const form = h(
    'form',
    null,
    h('img', { attrs: { src: '/logo.png', alt: '' } }),
    h('h1', { text: 'WebHub' }),
    input,
    button,
    error,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    button.disabled = true;
    error.textContent = '';
    try {
      await api('POST', '/api/login', { pin: input.value });
      input.value = '';
      root.className = '';
      await boot();
    } catch (err) {
      error.textContent = (err as Error).message;
      input.select();
    } finally {
      button.disabled = false;
    }
  });
  clear(root, form);
  input.focus();
}

// ---------------------------------------------------------------- estructura

interface Layout {
  shell: HTMLElement;
  nav: HTMLElement;
  search: HTMLInputElement;
  title: HTMLElement;
  counter: HTMLElement;
  actions: HTMLElement;
  content: HTMLElement;
}
let layout: Layout | null = null;

function buildLayout(): void {
  const search = h('input', {
    class: 'campo',
    attrs: { type: 'search', placeholder: 'Buscar…', 'aria-label': 'Buscar enlaces', autocomplete: 'off', spellcheck: 'false' },
  });
  const nav = h('nav', { class: 'nav', attrs: { 'aria-label': 'Familias' } });
  const title = h('h2');
  const counter = h('span', { class: 'contador' });
  const actions = h('div', { class: 'acciones-barra' });
  const content = h('main', { class: 'contenido', attrs: { tabindex: '-1' } });
  const shell = h(
    'div',
    { class: 'layout' },
    h(
      'aside',
      { class: 'sidebar' },
      h('a', { class: 'marca', attrs: { href: '#/todos' } }, h('img', { attrs: { src: '/logo.png', alt: '' } }), 'WebHub'),
      nav,
      h(
        'div',
        { class: 'pie' },
        h('a', { class: 'btn', text: '⚙ Administrar', attrs: { href: '#/admin' } }),
        h('button', { class: 'btn', text: 'Salir', attrs: { type: 'button' }, on: { click: logout } }),
      ),
    ),
    h('div', { class: 'velo', on: { click: () => toggleMenu(false) } }),
    h(
      'div',
      { class: 'principal' },
      h(
        'header',
        { class: 'barra' },
        h('button', { class: 'icono-btn menu-btn', text: '☰', title: 'Familias', attrs: { type: 'button', 'aria-label': 'Abrir familias' }, on: { click: () => toggleMenu() } }),
        title,
        counter,
        h('span', { class: 'espacio' }),
        h('div', { class: 'buscador' }, search, h('kbd', { text: 'Ctrl K' })),
        actions,
      ),
      content,
    ),
  );
  root.className = '';
  clear(root, shell);
  layout = { shell, nav, search, title, counter, actions, content };

  search.addEventListener('input', () => {
    state.query = search.value;
    renderContent();
  });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      focusLink(0);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      firstLink()?.click();
    } else if (ev.key === 'Escape') {
      if (search.value) {
        search.value = '';
        state.query = '';
        renderContent();
      } else {
        search.blur();
      }
    }
  });
  aplicarAspecto(content);
  attachTooltips(content, (a) => {
    const link = linkById(Number(a.dataset.id));
    return link ? tooltipOf(link) : null;
  });
  content.addEventListener('click', onLinkActivate);
  content.addEventListener('auxclick', (ev) => {
    if ((ev as MouseEvent).button === 1) onLinkActivate(ev);
  });
  content.addEventListener('keydown', onListKey);
}

function toggleMenu(open?: boolean): void {
  layout?.shell.classList.toggle('menu-abierto', open);
}

async function logout(): Promise<void> {
  try {
    await api('POST', '/api/logout');
  } finally {
    showLogin();
  }
}

function go(view: View): void {
  const hash = viewHash(view);
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route(): void {
  if (!layout) return;
  state.view = parseHash(location.hash);
  if (state.view.kind !== 'admin') {
    try {
      localStorage.setItem('webhub.vista', location.hash);
    } catch {
      /* sin almacenamiento local */
    }
  }
  toggleMenu(false);
  if (state.query) {
    state.query = '';
    layout.search.value = '';
  }
  renderSidebar();
  renderContent();
  layout.content.scrollTop = 0;
}

// ---------------------------------------------------------------- barra lateral

function navItem(label: string, count: number, href: string, active: boolean, sub = false): HTMLElement {
  return h(
    'a',
    { class: `nav-item${sub ? ' sub' : ''}${active ? ' activo' : ''}`, attrs: { href, 'aria-current': active ? 'page' : undefined } },
    h('span', { class: 'nombre', text: label }),
    h('span', { class: 'num', text: String(count) }),
  );
}

function renderSidebar(): void {
  if (!layout) return;
  const v = state.view;
  const searching = !!state.query.trim();
  const fav = favorites();
  const items: Node[] = [
    navItem('Todos', state.links.length, '#/todos', !searching && v.kind === 'all'),
    navItem('★ Favoritos y más usados', new Set([...fav.starred, ...fav.top]).size, '#/favoritos', !searching && v.kind === 'fav'),
  ];
  if (state.families.length) items.push(h('div', { class: 'nav-sep', text: 'Familias' }));
  for (const f of topFamilies()) {
    const activeId = v.kind === 'family' && !searching ? v.id : null;
    items.push(navItem(f.name, countFamily(f.id), `#/f/${f.id}`, activeId === f.id));
    for (const c of childrenOf(f.id)) items.push(navItem(c.name, linksOf(c.id).length, `#/f/${c.id}`, activeId === c.id, true));
  }
  clear(layout.nav, ...items);
}

// ---------------------------------------------------------------- listas

function linkRow(link: Link, showFamily = false): HTMLElement {
  const anchor = h(
    'a',
    {
      class: 'link',
      attrs: { href: link.url, target: '_blank', rel: 'noopener noreferrer' },
      data: { id: link.id },
    },
    favicon(link.domain),
    h('span', { class: 'titulo', text: link.title }),
    h('span', { class: 'dominio', text: link.domain }),
    link.note ? h('span', { class: 'nota', text: link.note }) : null,
    showFamily ? h('span', { class: 'familia-tag', text: familyLabel(link.familyId) }) : null,
  );
  const star = h('button', {
    class: `icono-btn estrella${link.favorite ? ' on' : ''}`,
    text: link.favorite ? '★' : '☆',
    title: link.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos',
    attrs: { type: 'button', tabindex: '-1', 'aria-label': link.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos' },
    on: { click: () => void toggleFavorite(link) },
  });
  return h('li', { class: 'fila' }, anchor, star);
}

function tooltipOf(link: Link): HTMLElement {
  return h(
    'div',
    null,
    h('div', { class: 'tt-titulo', text: link.title }),
    h('div', { class: 'tt-url', text: link.url }),
    link.note ? h('div', { class: 'tt-nota', text: link.note }) : null,
    link.tags.length ? h('div', { class: 'tt-etiquetas' }, ...link.tags.map((t) => h('span', { class: 'chip', text: `#${t}` }))) : null,
    link.clicks > 0 ? h('div', { class: 'tt-uso', text: `Abierto ${link.clicks} ${link.clicks === 1 ? 'vez' : 'veces'}` }) : null,
  );
}

// Bloques plegados: preferencia de este navegador.
const CLAVE_PLEGADOS = 'webhub.plegados';
const plegados = (() => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CLAVE_PLEGADOS) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
})();

function alternarPlegado(key: string): void {
  if (!plegados.delete(key)) plegados.add(key);
  try {
    localStorage.setItem(CLAVE_PLEGADOS, JSON.stringify([...plegados]));
  } catch {
    /* sin almacenamiento local */
  }
  renderContent();
  layout?.content.querySelector<HTMLElement>(`[data-plegar="${key}"]`)?.focus();
}

let arrastrada: Family | null = null;

function marcarDestino(section: HTMLElement | null, after = false): void {
  document.querySelectorAll('.bloque.antes, .bloque.despues').forEach((el) => el.classList.remove('antes', 'despues'));
  section?.classList.add(after ? 'despues' : 'antes');
}

/** Hace arrastrable el bloque de una familia desde su título, entre familias del mismo nivel. */
function makeDraggable(section: HTMLElement, head: HTMLElement, family: Family): void {
  head.draggable = true;
  head.addEventListener('dragstart', (ev) => {
    arrastrada = family;
    hideTooltip();
    section.classList.add('arrastrando');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', family.name);
      ev.dataTransfer.setDragImage(section, 12, 12);
    }
  });
  head.addEventListener('dragend', () => {
    arrastrada = null;
    section.classList.remove('arrastrando');
    marcarDestino(null);
  });
  const sameLevel = () => arrastrada !== null && arrastrada.parentId === family.parentId && arrastrada.id !== family.id;
  const isAfter = (ev: DragEvent) => {
    const r = section.getBoundingClientRect();
    return ev.clientY > r.top + r.height / 2;
  };
  section.addEventListener('dragover', (ev) => {
    if (!sameLevel()) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    marcarDestino(section, isAfter(ev));
  });
  section.addEventListener('dragleave', (ev) => {
    if (!section.contains(ev.relatedTarget as Node | null)) section.classList.remove('antes', 'despues');
  });
  section.addEventListener('drop', async (ev) => {
    if (!sameLevel() || !arrastrada) return;
    ev.preventDefault();
    const dragged = arrastrada;
    const siblings = (family.parentId === null ? topFamilies() : childrenOf(family.parentId)).map((f) => f.id);
    marcarDestino(null);
    try {
      await api('PUT', '/api/families/order', { parentId: family.parentId, ids: dropReorder(siblings, dragged.id, family.id, isAfter(ev)) });
      await reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  });
}

interface BlockOptions {
  href?: string;
  count?: number;
  showFamily?: boolean;
  /** Identifica el bloque para recordar si está plegado; sin clave, no se puede plegar. */
  key?: string;
  /** Familia que representa el bloque; si se indica, se puede arrastrar para reordenarla. */
  family?: Family;
}

function block(title: string | null, links: Link[], opts: BlockOptions = {}): HTMLElement | null {
  if (links.length === 0) return null;
  const collapsed = !!title && !!opts.key && plegados.has(opts.key);
  const section = h('section', { class: `bloque${collapsed ? ' plegado' : ''}` });
  if (title) {
    const head = h('h3');
    if (opts.key) {
      const key = opts.key;
      head.append(
        h('button', {
          class: 'plegar',
          text: '▾',
          data: { plegar: key },
          attrs: { type: 'button', 'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Desplegar' : 'Plegar'} ${title}` },
          on: { click: () => alternarPlegado(key) },
        }),
      );
    }
    head.append(
      opts.href ? h('a', { text: title, attrs: { href: opts.href, draggable: 'false' } }) : title,
      h('span', { class: 'num', text: String(opts.count ?? links.length) }),
    );
    section.append(head);
    if (opts.family) makeDraggable(section, head, opts.family);
  }
  if (!collapsed) section.append(h('ul', { class: 'lista' }, ...links.map((l) => linkRow(l, opts.showFamily))));
  return section;
}

function emptyState(message: string, withActions = false): HTMLElement {
  return h(
    'div',
    { class: 'vacio' },
    h('div', { text: message }),
    withActions
      ? h(
          'div',
          null,
          h('button', { class: 'btn primario', text: '+ Crear familia', attrs: { type: 'button' }, on: { click: () => familyDialog(null, null, reload) } }),
          ' ',
          h('a', { class: 'btn', text: 'Importar marcadores del navegador', attrs: { href: '#/admin/importar' } }),
        )
      : null,
  );
}

function setHeader(title: string, count: number | null, actions: Node[] = []): void {
  if (!layout) return;
  layout.title.textContent = title;
  layout.counter.textContent = count === null ? '' : `${count} enlace${count === 1 ? '' : 's'}`;
  clear(layout.actions, ...actions);
  document.title = `${title} · WebHub`;
}

function addLinkButton(familyId: number | null): HTMLElement {
  return h('button', { class: 'btn', text: '+ Enlace', attrs: { type: 'button' }, on: { click: () => linkDialog(null, familyId, reload) } });
}

function renderContent(): void {
  if (!layout) return;
  hideTooltip();
  const { content } = layout;
  const v = state.view;
  const query = state.query.trim();

  if (query) {
    const withFamily = state.links.map((l) => Object.assign(Object.create(null), l, { familyName: familyLabel(l.familyId) }) as Link & { familyName: string });
    const results = searchLinks(withFamily, query);
    setHeader(`Buscar «${query}»`, results.length);
    clear(content, results.length ? h('div', { class: 'columnas' }, block(null, results, { showFamily: true })) : emptyState('Sin resultados.'));
    renderSidebar();
    return;
  }

  if (v.kind === 'admin') {
    setHeader('Administración', null);
    renderAdmin(content, v.tab, reload);
    return;
  }

  if (state.families.length === 0) {
    setHeader('WebHub', null);
    clear(content, emptyState('Todavía no hay enlaces. Empieza creando una familia o importa tus marcadores.', true));
    return;
  }

  if (v.kind === 'fav') {
    const { starred, top } = favorites();
    setHeader('Favoritos y más usados', new Set([...starred, ...top]).size, [addLinkButton(null)]);
    const blocks = [block('Favoritos', starred, { showFamily: true, key: 'fav' }), block('Más usados', top, { showFamily: true, key: 'top' })].filter(Boolean);
    clear(content, blocks.length ? h('div', { class: 'columnas' }, ...blocks) : emptyState('Marca enlaces con ☆ o úsalos: aquí aparecerán los favoritos y los más abiertos.'));
    return;
  }

  if (v.kind === 'family') {
    const f = familyById(v.id);
    if (!f) return go({ kind: 'all' });
    const kids = childrenOf(f.id);
    setHeader(familyLabel(f.id), countFamily(f.id), [
      h('button', { class: 'btn', text: '✎', title: 'Editar familia', attrs: { type: 'button', 'aria-label': 'Editar familia' }, on: { click: () => familyDialog(f, null, reload) } }),
      addLinkButton(f.id),
    ]);
    const blocks = [
      block(kids.length ? f.name : null, linksOf(f.id), { key: `f${f.id}` }),
      ...kids.map((c) => block(c.name, linksOf(c.id), { href: `#/f/${c.id}`, key: `f${c.id}`, family: c })),
    ].filter(Boolean);
    clear(content, blocks.length ? h('div', { class: 'columnas' }, ...blocks) : emptyState('Esta familia está vacía.'));
    return;
  }

  // Todos: cada familia y subfamilia como bloque, en columnas.
  setHeader('Todos', state.links.length, [addLinkButton(null)]);
  const blocks: (HTMLElement | null)[] = [];
  for (const f of topFamilies()) {
    blocks.push(block(f.name, linksOf(f.id), { href: `#/f/${f.id}`, key: `f${f.id}`, family: f }));
    for (const c of childrenOf(f.id)) blocks.push(block(`${f.name} › ${c.name}`, linksOf(c.id), { href: `#/f/${c.id}`, key: `f${c.id}`, family: c }));
  }
  const visible = blocks.filter(Boolean);
  clear(content, visible.length ? h('div', { class: 'columnas' }, ...visible) : emptyState('Las familias están vacías. Añade enlaces con «+ Enlace».'));
}

// ---------------------------------------------------------------- interacción

function onLinkActivate(ev: Event): void {
  const a = (ev.target as HTMLElement).closest('a.link') as HTMLAnchorElement | null;
  if (!a) return;
  const id = Number(a.dataset.id);
  const link = linkById(id);
  if (!link) return;
  sendClick(id);
  link.clicks++;
  link.lastClickAt = new Date().toISOString();
}

async function toggleFavorite(link: Link): Promise<void> {
  try {
    await api('PATCH', `/api/links/${link.id}`, { favorite: !link.favorite });
    link.favorite = !link.favorite;
    renderSidebar();
    const focused = document.activeElement as HTMLElement | null;
    const id = focused?.dataset.id;
    renderContent();
    if (id) (layout?.content.querySelector(`a.link[data-id="${id}"]`) as HTMLElement | null)?.focus();
  } catch (err) {
    toast((err as Error).message, true);
  }
}

const allLinks = () => [...(layout?.content.querySelectorAll<HTMLAnchorElement>('a.link') ?? [])];
const firstLink = () => allLinks()[0];

function focusLink(index: number): void {
  const links = allLinks();
  if (links.length === 0) return;
  const target = links[Math.max(0, Math.min(index, links.length - 1))]!;
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

function onListKey(ev: KeyboardEvent): void {
  const a = (ev.target as HTMLElement).closest?.('a.link');
  if (!a) return;
  const links = allLinks();
  const i = links.indexOf(a as HTMLAnchorElement);
  if (ev.key === 'ArrowDown' || ev.key === 'j') {
    ev.preventDefault();
    focusLink(i + 1);
  } else if (ev.key === 'ArrowUp' || ev.key === 'k') {
    ev.preventDefault();
    if (i === 0) layout?.search.focus();
    else focusLink(i - 1);
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    focusLink(0);
  } else if (ev.key === 'End') {
    ev.preventDefault();
    focusLink(links.length - 1);
  } else if (ev.key === 'Escape') {
    layout?.search.focus();
  } else if (ev.key === 'f') {
    const link = linkById(Number((a as HTMLElement).dataset.id));
    if (link) void toggleFavorite(link);
  }
}

document.addEventListener('keydown', (ev) => {
  if (!layout) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target as HTMLElement).tagName) || document.querySelector('dialog[open]');
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    layout.search.focus();
    layout.search.select();
  } else if (!typing && ev.key === '/') {
    ev.preventDefault();
    layout.search.focus();
  } else if (!typing && (ev.key === 'ArrowDown' || ev.key === 'j') && !(ev.target as HTMLElement).closest('a.link')) {
    ev.preventDefault();
    focusLink(0);
  }
});

void boot();
