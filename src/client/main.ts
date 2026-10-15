import { h, clear, toast, favicon } from './dom.ts';
import { api, sendClick, setUnauthorizedHandler } from './api.ts';
import {
  state, load, topFamilies, childrenOf, familyById, linksOf, linkById, countFamily, familyLabel, favorites, parseHash, viewHash,
  type View,
} from './state.ts';
import { searchLinks } from '../shared/search.ts';
import { linkDialog, familyDialog } from './dialogs.ts';
import { renderAdmin } from './admin.ts';
import { aplicarFondo, aspectoActual, cargarAspecto } from './aspecto.ts';
import { passkeysSupported, platformAvailable, loginWithPasskey, deviceHasPasskey, registerPasskey, defaultDeviceName, dismissPasskeyOffer, passkeyOfferDismissed } from './passkeys.ts';
import { attachTooltips, hideTooltip } from './tooltip.ts';
import { dropReorder } from '../shared/order.ts';
import { numeroDeColumnas, asignarColumnas, moverGrupo } from '../shared/layout.ts';
import type { Destino } from '../shared/layout.ts';
import type { Family, Link, Snapshot } from '../shared/types.ts';

const root = document.getElementById('app') as HTMLElement;

// ---------------------------------------------------------------- arranque

async function boot(): Promise<void> {
  setUnauthorizedHandler(() => showLogin());
  try {
    const session = await api<{ authenticated: boolean; configured: boolean; passkeys: boolean; pin?: boolean }>('GET', '/api/session');
    if (!session.authenticated) return showLogin({ configured: session.configured, passkeys: session.passkeys, pin: session.pin ?? true, auto: true });
    await Promise.all([reload(), cargarAspecto()]);
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

async function showLogin(opts: { configured?: boolean; passkeys?: boolean; pin?: boolean; auto?: boolean } = {}): Promise<void> {
  const auto = opts.auto ?? false;
  let configured: boolean;
  let passkeys: boolean;
  let pin: boolean;
  if (opts.passkeys === undefined) {
    // Esta ruta es pública y responde 200; aun así se evita que un 401 hipotético
    // vuelva a disparar el manejador de sesión caducada (y por tanto showLogin).
    setUnauthorizedHandler(() => {});
    try {
      const session = await api<{ authenticated: boolean; configured: boolean; passkeys: boolean; pin?: boolean }>('GET', '/api/session');
      configured = session.configured;
      passkeys = session.passkeys;
      pin = session.pin ?? true;
    } catch {
      configured = true;
      passkeys = false;
      pin = true;
    } finally {
      setUnauthorizedHandler(() => showLogin());
    }
  } else {
    configured = opts.configured ?? true;
    passkeys = opts.passkeys;
    pin = opts.pin ?? true;
  }
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
  const compatible = passkeys && passkeysSupported() && (await platformAvailable());
  let huellaBtn: HTMLButtonElement | null = null;
  let separador: HTMLElement | null = null;
  if (compatible) {
    huellaBtn = h('button', { class: 'btn primario', text: 'Entrar con huella', attrs: { type: 'button' } });
    separador = h('div', { class: 'separador', text: 'o con el PIN' });
    huellaBtn.addEventListener('click', async () => {
      huellaBtn!.disabled = true;
      error.textContent = '';
      try {
        await loginWithPasskey();
        root.className = '';
        await boot();
        void mostrarAvisoSeguridad();
      } catch (err) {
        error.textContent = (err as Error).message;
        huellaBtn!.disabled = false;
      }
    });
  }
  // Cuando el PIN está desactivado, la entrada solo se hace con huella.
  const pinDesactivado = !pin;
  const avisoPin = pinDesactivado ? h('p', { text: 'La entrada con PIN está desactivada: usa la huella.' }) : null;
  if (pinDesactivado && !compatible) {
    error.textContent = 'Este dispositivo no admite huella. Entra desde un dispositivo con la huella activada o reactiva el PIN en el servidor con «npm run pin».';
  }
  // El separador «o con el PIN» solo tiene sentido cuando el PIN está activo.
  if (pinDesactivado) separador = null;
  const form = h(
    'form',
    null,
    h('img', { attrs: { src: '/logo.png', alt: '' } }),
    h('h1', { text: 'WebHub' }),
    avisoPin,
    ...(pinDesactivado ? [] : [huellaBtn as any, separador as any]),
    ...(pinDesactivado ? [] : [input, button]),
    huellaBtn && pinDesactivado ? huellaBtn : null,
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
      if (passkeysSupported() && (await platformAvailable()) && !deviceHasPasskey() && !passkeyOfferDismissed()) {
        mostrarAvisoHuella();
      }
      void mostrarAvisoSeguridad();
    } catch (err) {
      error.textContent = (err as Error).message;
      input.select();
    } finally {
      button.disabled = false;
    }
  });
  clear(root, form);
  input.focus();

  if (auto && compatible && deviceHasPasskey() && window.matchMedia('(pointer: coarse)').matches) {
    if (!arranqueHuellaDisparado) {
      arranqueHuellaDisparado = true;
      void (async () => {
        try {
          await loginWithPasskey();
          root.className = '';
          await boot();
          void mostrarAvisoSeguridad();
        } catch {
          /* sin error */
        }
      })();
    }
  }
}

let arranqueHuellaDisparado = false;

function mostrarAvisoHuella(): void {
  document.querySelector('.aviso-huella')?.remove();
  const activar = h('button', { class: 'btn primario', text: 'Activar', attrs: { type: 'button' } });
  const ahora = h('button', { class: 'btn', text: 'Ahora no', attrs: { type: 'button' } });
  const aviso = h(
    'div',
    { class: 'aviso-huella', attrs: { role: 'region', 'aria-label': '¿Entrar con huella en este dispositivo?' } },
    h('span', { text: '¿Entrar con huella en este dispositivo?' }),
    h('div', null, activar, ' ', ahora),
  );
  activar.addEventListener('click', async () => {
    activar.disabled = true;
    try {
      await registerPasskey(defaultDeviceName());
      aviso.remove();
      toast('Huella activada.');
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      activar.disabled = false;
    }
  });
  ahora.addEventListener('click', () => {
    dismissPasskeyOffer();
    aviso.remove();
  });
  document.body.append(aviso);
}

function mostrarAvisoSeguridad(): void {
  void (async () => {
    try {
      const res = await api<{ fallos: number; desde: string | null }>('GET', '/api/accesos/resumen');
      if (!res || !(res.fallos > 0)) return;
      document.querySelector('.aviso-seguridad')?.remove();
      const fecha = res.desde ? new Date(res.desde).toLocaleString('es-ES') : 'el principio';
      const texto = `Desde tu entrada anterior (${fecha}) ha habido ${res.fallos} intento${res.fallos === 1 ? '' : 's'} fallido${res.fallos === 1 ? '' : 's'} de entrada.`;
      const cerrar = h('button', { class: 'btn', text: 'Cerrar', attrs: { type: 'button' } });
      const ver = h('button', { class: 'btn primario', text: 'Ver registro', attrs: { type: 'button' } });
      const aviso = h(
        'div',
        { class: 'aviso-seguridad', attrs: { role: 'alert' } },
        h('span', { text: texto }),
        h('div', null, ver, ' ', cerrar),
      );
      ver.addEventListener('click', () => {
        aviso.remove();
        location.hash = '#/admin/acceso';
      });
      cerrar.addEventListener('click', () => aviso.remove());
      document.body.append(aviso);
    } catch {
      /* Si la consulta falla no se muestra nada. */
    }
  })();
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
let columnasActuales = 1;
let resizeObserverInstancia: ResizeObserver | null = null;
let ultimaAsignacion: Map<number, number> = new Map();

function anchoUtilContenido(): number {
  if (!layout) return 0;
  const c = layout.content;
  const st = getComputedStyle(c);
  const pad = parseFloat(st.paddingLeft) + parseFloat(st.paddingRight);
  return c.clientWidth - pad;
}
function rootPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

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
  aplicarFondo(content, aspectoActual());
  attachTooltips(content, (a) => {
    const link = linkById(Number(a.dataset.id));
    return link ? tooltipOf(link) : null;
  });
  content.addEventListener('click', onLinkActivate);
  content.addEventListener('auxclick', (ev) => {
    if ((ev as MouseEvent).button === 1) onLinkActivate(ev);
  });
  content.addEventListener('keydown', onListKey);
  document.addEventListener('dragend', () => {
    arrastrada = null;
    grupoArrastrado = null;
    limpiarMarcasDrag();
  });

  // Reparto en columnas explícitas: recalcular número de columnas al cambiar el ancho.
  let resizeRaf = 0;
  const observer = new ResizeObserver(() => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (!layout) return;
      if (state.view.kind === 'admin') return;
      const n = numeroDeColumnas(anchoUtilContenido(), 20.625 * rootPx(), 1.6 * rootPx());
      if (n !== columnasActuales) {
        columnasActuales = n;
        renderContent();
      }
    });
  });
  observer.observe(content);
  resizeObserverInstancia = observer;
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

const CLAVE_DESPLEGADOS = 'webhub.desplegados';
const desplegados = (() => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CLAVE_DESPLEGADOS) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
})();

function alternarPlegado(key: string, defaultCollapsed = false): void {
  const nowCollapsed = plegados.has(key) || (defaultCollapsed && !desplegados.has(key));
  if (nowCollapsed) {
    plegados.delete(key);
    if (defaultCollapsed) desplegados.add(key);
  } else {
    desplegados.delete(key);
    plegados.add(key);
  }
  try {
    localStorage.setItem(CLAVE_PLEGADOS, JSON.stringify([...plegados]));
    localStorage.setItem(CLAVE_DESPLEGADOS, JSON.stringify([...desplegados]));
  } catch {
    /* sin almacenamiento local */
  }
  renderContent();
  layout?.content.querySelector<HTMLElement>(`[data-plegar="${key}"]`)?.focus();
}

let arrastrada: Family | null = null;
let grupoArrastrado: number | null = null;
let enTodos = false;

function marcarDestino(section: HTMLElement | null, after = false): void {
  document.querySelectorAll('.bloque.antes, .bloque.despues').forEach((el) => el.classList.remove('antes', 'despues'));
  section?.classList.add(after ? 'despues' : 'antes');
}

function limpiarMarcasDrag(): void {
  document.querySelectorAll('.columna.destino-final').forEach((el) => el.classList.remove('destino-final'));
  document.querySelectorAll('.bloque.antes, .bloque.despues').forEach((el) => el.classList.remove('antes', 'despues'));
}

/** Hace arrastrable el bloque de una familia desde su título, entre familias del mismo nivel. */
function makeDraggable(section: HTMLElement, head: HTMLElement, family: Family): void {
  head.draggable = true;
  head.addEventListener('dragstart', (ev) => {
    arrastrada = family;
    grupoArrastrado = family.parentId ?? family.id;
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
    grupoArrastrado = null;
    section.classList.remove('arrastrando');
    marcarDestino(null);
    limpiarMarcasDrag();
  });
  const sameLevel = () => arrastrada !== null && arrastrada.parentId === family.parentId && arrastrada.id !== family.id;
  const isAfter = (ev: DragEvent) => {
    const r = section.getBoundingClientRect();
    return ev.clientY > r.top + r.height / 2;
  };
  section.addEventListener('dragover', (ev) => {
    if (enTodos) return;
    if (!sameLevel()) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    marcarDestino(section, isAfter(ev));
  });
  section.addEventListener('dragleave', (ev) => {
    if (!section.contains(ev.relatedTarget as Node | null)) section.classList.remove('antes', 'despues');
  });
  section.addEventListener('drop', async (ev) => {
    if (enTodos) return;
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
  /** Marca «plegada por defecto» de la familia que representa el bloque. */
  defaultCollapsed?: boolean;
  /** Id del grupo (familia principal) al que pertenece el bloque. */
  grupo?: number;
}

function block(title: string | null, links: Link[], opts: BlockOptions = {}): HTMLElement | null {
  if (links.length === 0) return null;
  const defaultCollapsed = opts.defaultCollapsed === true;
  const collapsed = !!title && !!opts.key && (plegados.has(opts.key) || (defaultCollapsed && !desplegados.has(opts.key)));
  const section = h('section', { class: `bloque${collapsed ? ' plegado' : ''}` });
  if (opts.grupo !== undefined) section.dataset.grupo = String(opts.grupo);
  if (opts.family) section.dataset.familia = String(opts.family.id);
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
          on: { click: () => alternarPlegado(key, defaultCollapsed) },
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

function instalarArrastreColumna(colEl: HTMLElement, colIndex: number): void {
  colEl.addEventListener('dragover', (ev) => {
    if (!arrastrada || grupoArrastrado === null) return;
    const res = resolverDestinoFn(colEl, ev);
    if (res.tipo === 'nada') return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    limpiarMarcasDrag();
    if (res.tipo === 'final') {
      colEl.classList.add('destino-final');
      return;
    }
    if (res.tipo === 'hermanas') {
      res.target.classList.add(res.after ? 'despues' : 'antes');
      return;
    }
    const blocks = [...colEl.querySelectorAll<HTMLElement>('.bloque')];
    const grupoBlocks = blocks.filter((b) => Number(b.dataset.grupo) === res.H);
    if (res.after) grupoBlocks[grupoBlocks.length - 1]?.classList.add('despues');
    else grupoBlocks[0]?.classList.add('antes');
  });
  colEl.addEventListener('dragleave', (ev) => {
    if (colEl.contains(ev.relatedTarget as Node | null)) return;
    colEl.classList.remove('destino-final');
    limpiarMarcasDrag();
  });
  colEl.addEventListener('drop', async (ev) => {
    if (!arrastrada || grupoArrastrado === null) return;
    const res = resolverDestinoFn(colEl, ev);
    if (res.tipo === 'nada') return;
    ev.preventDefault();
    const dragged = arrastrada;
    const G = grupoArrastrado;
    limpiarMarcasDrag();
    colEl.classList.remove('destino-final');
    if (res.tipo === 'hermanas') {
      const targetFamily = familyById(Number(res.target.dataset.familia));
      if (!targetFamily) return;
      const parent = targetFamily.parentId;
      const siblings = (parent === null ? topFamilies() : childrenOf(parent)).map((f) => f.id);
      try {
        await api('PUT', '/api/families/order', { parentId: parent, ids: dropReorder(siblings, dragged.id, targetFamily.id, res.after) });
        await reload();
      } catch (err) {
        toast((err as Error).message, true);
      }
      return;
    }
    const order = topFamilies().map((f) => f.id);
    const guardadas = new Map(topFamilies().map((f) => [f.id, f.col]));
    const efectivas = ultimaAsignacion;
    const destino: Destino =
      res.tipo === 'final'
        ? { tipo: 'final', col: colIndex }
        : { tipo: res.after ? 'despues' : 'antes', id: res.H };
    try {
      const out = moverGrupo(order, guardadas, efectivas, G, destino);
      await api('PUT', '/api/families/layout', { items: out.items });
      await reload();
    } catch (err) {
      toast((err as Error).message, true);
    }
  });
}

function resolverDestinoFn(colEl: HTMLElement, ev: DragEvent): { tipo: 'final' } | { tipo: 'hermanas'; target: HTMLElement; after: boolean } | { tipo: 'grupo'; target: HTMLElement; H: number; after: boolean } | { tipo: 'nada' } {
  const blocks = [...colEl.querySelectorAll<HTMLElement>('.bloque')];
  const y = ev.clientY;
  if (!blocks.length) return { tipo: 'final' };
  const firstRect = blocks[0].getBoundingClientRect();
  const lastRect = blocks[blocks.length - 1].getBoundingClientRect();
  let target: HTMLElement | null = null;
  let after = false;
  if (y < firstRect.top) {
    // Por encima del primer bloque: objetivo = primero, "antes".
    target = blocks[0];
    after = false;
  } else if (y > lastRect.bottom) {
    // Por debajo del último bloque: destino 'final'.
    return { tipo: 'final' };
  } else {
    // (1) Dentro del rectángulo de algún bloque.
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) {
        target = b;
        after = y > r.top + r.height / 2;
        break;
      }
    }
    // (2) Hueco entre dos bloques: el más cercano por distancia al borde.
    if (!target) {
      for (let i = 0; i < blocks.length - 1; i++) {
        const rp = blocks[i].getBoundingClientRect();
        const rn = blocks[i + 1].getBoundingClientRect();
        if (y > rp.bottom && y < rn.top) {
          const dPrev = y - rp.bottom;
          const dNext = rn.top - y;
          if (dNext <= dPrev) {
            target = blocks[i + 1];
            after = false;
          } else {
            target = blocks[i];
            after = true;
          }
          break;
        }
      }
    }
  }
  if (!target) return { tipo: 'final' };
  const tf = familyById(Number(target.dataset.familia));
  const H = Number(target.dataset.grupo);
  const arr = arrastrada!;
  const esHermanas = arr.parentId !== null && !!tf && tf.parentId !== null && arr.parentId === tf.parentId;
  if (esHermanas) {
    // "antes/después" según la mitad del bloque objetivo.
    const r = target.getBoundingClientRect();
    return { tipo: 'hermanas', target, after: y > r.top + r.height / 2 };
  }
  if (H !== grupoArrastrado) {
    // "antes/después" del GRUPO H: centro vertical del conjunto de sus bloques.
    const grupoBlocks = blocks.filter((b) => Number(b.dataset.grupo) === H);
    const firstGrRect = grupoBlocks[0]?.getBoundingClientRect();
    const lastGrRect = grupoBlocks[grupoBlocks.length - 1]?.getBoundingClientRect();
    const center = firstGrRect && lastGrRect ? (firstGrRect.top + lastGrRect.bottom) / 2 : y;
    return { tipo: 'grupo', target, H, after: y > center };
  }
  return { tipo: 'nada' };
}

function renderColumnas(grupos: { id: number; col: number | null; peso: number; blocks: HTMLElement[] }[]): HTMLElement {
  const n = numeroDeColumnas(anchoUtilContenido(), 20.625 * rootPx(), 1.6 * rootPx());
  columnasActuales = n;
  const asignacion = asignarColumnas(grupos.map((g) => ({ id: g.id, col: g.col, peso: g.peso })), n);
  if (enTodos) ultimaAsignacion = asignacion;
  const cols: HTMLElement[] = Array.from({ length: n }, (_, i) => {
    const col = h('div', { class: 'columna', data: { col: i } });
    if (enTodos) instalarArrastreColumna(col, i);
    return col;
  });
  for (const g of grupos) {
    const ci = asignacion.get(g.id) ?? 0;
    const safe = ci >= 0 && ci < cols.length ? ci : 0;
    for (const b of g.blocks) cols[safe].append(b);
  }
  return h('div', { class: 'columnas' }, ...cols);
}

function renderContent(): void {
  if (!layout) return;
  hideTooltip();
  const { content } = layout;
  const v = state.view;
  const query = state.query.trim();
  enTodos = false;

  if (query) {
    const withFamily = state.links.map((l) => Object.assign(Object.create(null), l, { familyName: familyLabel(l.familyId) }) as Link & { familyName: string });
    const results = searchLinks(withFamily, query);
    setHeader(`Buscar «${query}»`, results.length);
    enTodos = false;
    const blk = results.length ? block(null, results, { showFamily: true, grupo: -1 }) : null;
    const groups = blk ? [{ id: -1, col: null as number | null, peso: 2 + results.length, blocks: [blk] }] : [];
    clear(content, groups.length ? renderColumnas(groups) : emptyState('Sin resultados.'));
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
    let gi = -100;
    const groups: { id: number; col: number | null; peso: number; blocks: HTMLElement[] }[] = [];
    const b1 = starred.length ? block('Favoritos', starred, { showFamily: true, key: 'fav', grupo: gi }) : null;
    if (b1) { groups.push({ id: gi, col: null, peso: 2 + starred.length, blocks: [b1] }); gi--; }
    const b2 = top.length ? block('Más usados', top, { showFamily: true, key: 'top', grupo: gi }) : null;
    if (b2) { groups.push({ id: gi, col: null, peso: 2 + top.length, blocks: [b2] }); gi--; }
    clear(content, groups.length ? renderColumnas(groups) : emptyState('Marca enlaces con ☆ o úsalos: aquí aparecerán los favoritos y los más abiertos.'));
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
    let gi = -200;
    const groups: { id: number; col: number | null; peso: number; blocks: HTMLElement[] }[] = [];
    const parentLinks = linksOf(f.id);
    const parentBlock = parentLinks.length ? block(kids.length ? f.name : null, parentLinks, { key: `f${f.id}`, defaultCollapsed: f.collapsed, grupo: gi }) : null;
    if (parentBlock) { groups.push({ id: gi, col: null, peso: 2 + parentLinks.length, blocks: [parentBlock] }); gi--; }
    for (const c of kids) {
      const clinks = linksOf(c.id);
      if (!clinks.length) continue;
      const cb = block(c.name, clinks, { href: `#/f/${c.id}`, key: `f${c.id}`, family: c, defaultCollapsed: c.collapsed, grupo: gi });
      if (cb) { groups.push({ id: gi, col: null, peso: 2 + clinks.length, blocks: [cb] }); gi--; }
    }
    clear(content, groups.length ? renderColumnas(groups) : emptyState('Esta familia está vacía.'));
    return;
  }

  // Todos: grupos de familia principal + subfamilias, en columnas explícitas.
  setHeader('Todos', state.links.length, [addLinkButton(null)]);
  enTodos = true;
  const groups: { id: number; col: number | null; peso: number; blocks: HTMLElement[] }[] = [];
  for (const f of topFamilies()) {
    const principalLinks = linksOf(f.id);
    const childList = childrenOf(f.id).filter((c) => linksOf(c.id).length > 0);
    const hasAny = principalLinks.length > 0 || childList.length > 0;
    if (!hasAny) continue;
    let peso = 0;
    if (principalLinks.length) peso += 2 + principalLinks.length;
    const blocks: HTMLElement[] = [];
    if (principalLinks.length) {
      const pb = block(f.name, principalLinks, { href: `#/f/${f.id}`, key: `f${f.id}`, family: f, defaultCollapsed: f.collapsed, grupo: f.id });
      if (pb) { pb.dataset.grupo = String(f.id); blocks.push(pb); }
    }
    for (const c of childList) {
      const clinks = linksOf(c.id);
      peso += 2 + clinks.length;
      const cb = block(`${f.name} › ${c.name}`, clinks, { href: `#/f/${c.id}`, key: `f${c.id}`, family: c, defaultCollapsed: c.collapsed, grupo: f.id });
      if (cb) { cb.dataset.grupo = String(f.id); blocks.push(cb); }
    }
    if (!blocks.length) continue;
    groups.push({ id: f.id, col: f.col, peso, blocks });
  }
  clear(content, groups.length ? renderColumnas(groups) : emptyState('Las familias están vacías. Añade enlaces con «+ Enlace».'));
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
