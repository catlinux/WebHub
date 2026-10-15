import { h, clear, toast, favicon } from './dom.ts';
import { api } from './api.ts';
import { state, topFamilies, childrenOf, familyById, linksOf, countFamily, familyLabel } from './state.ts';
import { linkDialog, familyDialog, confirmDialog } from './dialogs.ts';
import { dropReorder, moveItem } from '../shared/order.ts';
import { classify } from '../shared/check.ts';
import { FONDOS, ASPECTO_INICIAL, TEMAS, FUENTES, DENSIDADES, PESOS_TITULO, type Aspecto } from '../shared/aspecto.ts';
import { aspectoActual, cambiarAspecto, aplicarFondo } from './aspecto.ts';
import { passkeysSupported, platformAvailable, registerPasskey, defaultDeviceName, markDevicePasskey } from './passkeys.ts';
import type { ImportPlan, PlanGroup } from '../shared/bookmarks.ts';
import type { Family, Link } from '../shared/types.ts';

type Reload = () => Promise<void>;
type Tab = 'organizar' | 'importar' | 'copia' | 'comprobar' | 'aspecto' | 'acceso';

const TABS: [Tab, string][] = [
  ['organizar', 'Organizar'],
  ['importar', 'Importar marcadores'],
  ['copia', 'Copia de seguridad'],
  ['comprobar', 'Enlaces rotos'],
  ['aspecto', 'Aspecto'],
  ['acceso', 'Acceso'],
];

export function renderAdmin(content: HTMLElement, tab: Tab, reload: Reload): void {
  const body = h('div', { class: 'admin-cuerpo' });
  const tabs = h(
    'nav',
    { class: 'pestanas', attrs: { 'aria-label': 'Secciones de administración' } },
    ...TABS.map(([id, label]) =>
      h('a', { class: id === tab ? 'activo' : '', text: label, attrs: { href: id === 'organizar' ? '#/admin' : `#/admin/${id}` } }),
    ),
  );
  clear(content, tabs, body);
  body.style.paddingTop = '.8rem';
  if (tab === 'organizar') renderOrganize(body, reload);
  else if (tab === 'importar') renderImport(body, reload);
  else if (tab === 'copia') renderBackup(body, reload);
  else if (tab === 'aspecto') renderAspecto(body, content);
  else if (tab === 'acceso') renderAcceso(body);
  else renderChecker(body, reload);
}

async function run(action: () => Promise<unknown>, reload: Reload, ok?: string): Promise<void> {
  try {
    await action();
    await reload();
    if (ok) toast(ok);
  } catch (err) {
    toast((err as Error).message, true);
    await reload().catch(() => {});
  }
}

// ================================================================ Organizar

let selectedFamily: number | null = null;
type Drag = { type: 'family'; id: number; parentId: number | null } | { type: 'link'; id: number; familyId: number };
let dragging: Drag | null = null;

function clearMarks(): void {
  document.querySelectorAll('.antes, .despues, .dentro').forEach((el) => el.classList.remove('antes', 'despues', 'dentro'));
}

function iconButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'icono-btn', text, title: label, attrs: { type: 'button', 'aria-label': label }, on: { click: onClick } });
}

function renderOrganize(container: HTMLElement, reload: Reload): void {
  if (selectedFamily === null || !familyById(selectedFamily)) selectedFamily = topFamilies()[0]?.id ?? null;

  const familyRows: HTMLElement[] = [];
  const siblingsIds = (parentId: number | null) => (parentId === null ? topFamilies() : childrenOf(parentId)).map((f) => f.id);
  const reorderFamilies = (parentId: number | null, ids: number[]) =>
    run(() => api('PUT', '/api/families/order', { parentId, ids }), reload);

  const familyRow = (f: Family): HTMLElement => {
    const sibs = siblingsIds(f.parentId);
    const i = sibs.indexOf(f.id);
    const row = h(
      'div',
      { class: `fila-admin${f.parentId !== null ? ' sub' : ''}${f.id === selectedFamily ? ' seleccionada' : ''}`, attrs: { draggable: 'true' } },
      h('span', { class: 'asa', text: '⠿', attrs: { 'aria-hidden': 'true' } }),
      h('span', {
        class: 'texto',
        text: f.name,
        attrs: { tabindex: '0', role: 'button' },
        on: {
          click: () => {
            selectedFamily = f.id;
            renderOrganize(container, reload);
            // En pantallas estrechas los enlaces quedan debajo: se lleva la vista hasta ellos.
            if (window.matchMedia('(max-width: 1180px)').matches) container.querySelector('.organizar > .panel:nth-child(2)')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          },
          keydown: (ev) => {
            if (ev.key === 'Enter') (ev.target as HTMLElement).click();
          },
        },
      }),
      h('span', { class: 'secundario', text: String(countFamily(f.id)) }),
      h(
        'span',
        { class: 'acc' },
        iconButton('↑', 'Subir', () => i > 0 && void reorderFamilies(f.parentId, moveItem(sibs, i, i - 1))),
        iconButton('↓', 'Bajar', () => i < sibs.length - 1 && void reorderFamilies(f.parentId, moveItem(sibs, i, i + 1))),
        f.parentId === null ? iconButton('+', 'Nueva subfamilia', () => familyDialog(null, f.id, reload)) : null,
        iconButton('✎', 'Editar', () => familyDialog(f, null, reload)),
        iconButton('🗑', 'Borrar', () => {
          const kids = childrenOf(f.id).length;
          const n = countFamily(f.id);
          confirmDialog(
            `Borrar «${f.name}»`,
            `Se borrarán ${n} enlace${n === 1 ? '' : 's'}${kids ? ` y ${kids} subfamilia${kids === 1 ? '' : 's'}` : ''}. No se puede deshacer (salvo restaurando una copia).`,
            'Borrar',
            () => run(() => api('DELETE', `/api/families/${f.id}`), reload, 'Familia borrada.'),
          );
        }),
      ),
    );
    row.addEventListener('dragstart', (ev) => {
      dragging = { type: 'family', id: f.id, parentId: f.parentId };
      ev.dataTransfer?.setData('text/plain', `familia:${f.id}`);
      row.classList.add('arrastrando');
    });
    row.addEventListener('dragend', () => {
      dragging = null;
      row.classList.remove('arrastrando');
      clearMarks();
    });
    row.addEventListener('dragover', (ev) => {
      if (!dragging) return;
      if (dragging.type === 'family' && dragging.parentId === f.parentId && dragging.id !== f.id) {
        ev.preventDefault();
        const r = row.getBoundingClientRect();
        clearMarks();
        row.classList.add(ev.clientY > r.top + r.height / 2 ? 'despues' : 'antes');
      } else if (dragging.type === 'link' && dragging.familyId !== f.id) {
        ev.preventDefault();
        clearMarks();
        row.classList.add('dentro');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('antes', 'despues', 'dentro'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const d = dragging;
      const after = row.classList.contains('despues');
      clearMarks();
      if (!d) return;
      if (d.type === 'family') void reorderFamilies(f.parentId, dropReorder(sibs, d.id, f.id, after));
      else void run(() => api('PATCH', `/api/links/${d.id}`, { familyId: f.id }), reload, `Movido a «${familyLabel(f.id)}».`);
    });
    return row;
  };

  for (const f of topFamilies()) {
    familyRows.push(familyRow(f));
    for (const c of childrenOf(f.id)) familyRows.push(familyRow(c));
  }

  const familiesPanel = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-cab' },
      h('h3', { text: 'Familias' }),
      h('button', { class: 'btn', text: '+ Familia', attrs: { type: 'button' }, on: { click: () => familyDialog(null, null, reload) } }),
    ),
    ...(familyRows.length ? familyRows : [h('div', { class: 'vacio', text: 'Aún no hay familias.' })]),
  );

  const linksPanel = h('section', { class: 'panel' });
  const sel = selectedFamily !== null ? familyById(selectedFamily) : undefined;
  if (sel) {
    const links = linksOf(sel.id);
    const ids = links.map((l) => l.id);
    const reorderLinks = (next: number[]) => run(() => api('PUT', '/api/links/order', { familyId: sel.id, ids: next }), reload);
    const linkRow = (l: Link, i: number): HTMLElement => {
      const row = h(
        'div',
        { class: 'fila-admin', attrs: { draggable: 'true' } },
        h('span', { class: 'asa', text: '⠿', attrs: { 'aria-hidden': 'true' } }),
        favicon(l.domain),
        h(
          'span',
          {
            class: 'texto',
            title: `${l.url}${l.note ? `\n${l.note}` : ''}`,
            attrs: { tabindex: '0', role: 'button' },
            on: {
              click: () => linkDialog(l, null, reload),
              keydown: (ev) => {
                if (ev.key === 'Enter') linkDialog(l, null, reload);
              },
            },
          },
          l.favorite ? '★ ' : '',
          l.title,
          ' ',
          h('span', { class: 'secundario', text: l.domain }),
          l.tags.length ? h('span', { class: 'secundario', text: `  #${l.tags.join(' #')}` }) : null,
        ),
        h(
          'span',
          { class: 'acc' },
          iconButton('↑', 'Subir', () => i > 0 && void reorderLinks(moveItem(ids, i, i - 1))),
          iconButton('↓', 'Bajar', () => i < ids.length - 1 && void reorderLinks(moveItem(ids, i, i + 1))),
          iconButton('✎', 'Editar', () => linkDialog(l, null, reload)),
          iconButton('🗑', 'Borrar', () =>
            confirmDialog('Borrar enlace', `¿Borrar «${l.title}»?`, 'Borrar', () => run(() => api('DELETE', `/api/links/${l.id}`), reload, 'Enlace borrado.')),
          ),
        ),
      );
      row.addEventListener('dragstart', (ev) => {
        dragging = { type: 'link', id: l.id, familyId: l.familyId };
        ev.dataTransfer?.setData('text/plain', `enlace:${l.id}`);
        row.classList.add('arrastrando');
      });
      row.addEventListener('dragend', () => {
        dragging = null;
        row.classList.remove('arrastrando');
        clearMarks();
      });
      row.addEventListener('dragover', (ev) => {
        if (dragging?.type !== 'link' || dragging.familyId !== sel.id || dragging.id === l.id) return;
        ev.preventDefault();
        const r = row.getBoundingClientRect();
        clearMarks();
        row.classList.add(ev.clientY > r.top + r.height / 2 ? 'despues' : 'antes');
      });
      row.addEventListener('dragleave', () => row.classList.remove('antes', 'despues'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const after = row.classList.contains('despues');
        clearMarks();
        if (dragging?.type === 'link') void reorderLinks(dropReorder(ids, dragging.id, l.id, after));
      });
      return row;
    };
    linksPanel.append(
      h(
        'div',
        { class: 'panel-cab' },
        h('h3', { text: `Enlaces de «${familyLabel(sel.id)}»` }),
        h('button', { class: 'btn', text: '+ Enlace', attrs: { type: 'button' }, on: { click: () => linkDialog(null, sel.id, reload) } }),
      ),
      h('p', { class: 'ayuda ayuda-raton', text: 'Arrastra por ⠿ para reordenar. Suelta un enlace sobre otra familia (columna izquierda) para moverlo.' }),
      h('p', { class: 'ayuda ayuda-tactil', text: 'Usa ↑ ↓ para reordenar. Para mover un enlace a otra familia, edítalo (✎) y cambia la familia.' }),
      ...(links.length ? links.map(linkRow) : [h('div', { class: 'vacio', text: 'Familia sin enlaces.' })]),
    );
  } else {
    linksPanel.append(h('div', { class: 'vacio', text: 'Crea una familia para empezar a añadir enlaces.' }));
  }
  clear(container, h('div', { class: 'organizar' }, familiesPanel, linksPanel));
}

// ================================================================ Importar marcadores

/** Los navegadores incrustan los favicons en base64 (ICON="data:…"): no los necesitamos y pesan mucho. */
/** Selector de archivo con texto propio: el nativo muestra «Choose File» según el idioma del navegador. */
function filePicker(input: HTMLInputElement, label: string): HTMLElement {
  const name = h('span', { class: 'nombre-archivo', text: 'Ningún archivo elegido' });
  input.addEventListener('change', () => (name.textContent = input.files?.[0]?.name ?? 'Ningún archivo elegido'));
  return h('label', { class: 'archivo' }, input, h('span', { class: 'btn', text: label }), name);
}

function slimBookmarks(html: string): string {
  return html.replace(/\s(ICON|ICON_URI)="[^"]*"/gi, '');
}

function renderImport(container: HTMLElement, reload: Reload): void {
  let html = '';
  let plan: ImportPlan | null = null;
  const excluded = new Set<string>();
  const file = h('input', { attrs: { type: 'file', accept: '.html,.htm,text/html' } });
  const unwrap = h('input', { attrs: { type: 'checkbox', checked: true } });
  const skipDup = h('input', { attrs: { type: 'checkbox', checked: true } });
  const preview = h('div');

  const loadPreview = async () => {
    if (!html) return;
    clear(preview, h('p', { class: 'ayuda', text: 'Analizando…' }));
    try {
      plan = await api<ImportPlan>('POST', '/api/import/bookmarks/preview', { html, unwrapContainers: unwrap.checked });
      excluded.clear();
      drawPlan();
    } catch (err) {
      clear(preview, h('p', { class: 'error', text: (err as Error).message }));
    }
  };

  const included = (g: PlanGroup) => !excluded.has(g.key) && !(g.parentKey && excluded.has(g.parentKey));
  const linksToImport = () =>
    plan ? plan.groups.filter(included).reduce((n, g) => n + g.links.filter((l) => !(skipDup.checked && l.duplicate)).length, 0) : 0;

  const drawPlan = () => {
    if (!plan) return;
    const p = plan;
    if (p.totalLinks === 0) {
      clear(preview, h('p', { class: 'ayuda', text: 'No se han encontrado enlaces http/https en el archivo.' }));
      return;
    }
    const importBtn = h('button', { class: 'btn primario', attrs: { type: 'button' } });
    const updateButton = () => {
      const n = linksToImport();
      importBtn.textContent = `Importar ${n} enlace${n === 1 ? '' : 's'}`;
      importBtn.disabled = n === 0;
    };
    const groups = p.groups.map((g) => {
      const box = h('input', { attrs: { type: 'checkbox', checked: included(g), disabled: !!(g.parentKey && excluded.has(g.parentKey)) } });
      box.addEventListener('click', (ev) => ev.stopPropagation());
      box.addEventListener('change', () => {
        if (box.checked) excluded.delete(g.key);
        else excluded.add(g.key);
        drawPlan();
      });
      const dups = g.links.filter((l) => l.duplicate).length;
      return h(
        'details',
        { class: `grupo-import${g.parentKey ? ' sub' : ''}` },
        h(
          'summary',
          null,
          box,
          h('span', { class: 'nombre', text: g.name }),
          g.existingFamilyId ? h('span', { class: 'chip', text: 'ya existe: se añade ahí' }) : h('span', { class: 'chip nueva', text: g.parentKey ? 'subfamilia nueva' : 'familia nueva' }),
          dups ? h('span', { class: 'chip dup', text: `${dups} duplicado${dups === 1 ? '' : 's'}` }) : null,
          h('span', { class: 'secundario', text: `${g.links.length} enlace${g.links.length === 1 ? '' : 's'}` }),
        ),
        h(
          'ul',
          null,
          ...g.links.map((l) =>
            h(
              'li',
              { title: l.url },
              l.duplicate ? h('span', { class: 'chip dup', text: l.duplicate === 'existing' ? 'ya en WebHub' : 'repetido en el archivo' }) : null,
              l.duplicate ? ' ' : '',
              l.title,
              ' ',
              h('span', { class: 'secundario', text: l.domain }),
            ),
          ),
        ),
      );
    });
    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      try {
        const r = await api<{ links: number; families: number }>('POST', '/api/import/bookmarks/confirm', {
          html,
          unwrapContainers: unwrap.checked,
          excluded: [...excluded],
          skipDuplicates: skipDup.checked,
        });
        await reload();
        toast(`Importados ${r.links} enlaces en ${r.families} familias nuevas.`);
        location.hash = '#/todos';
      } catch (err) {
        toast((err as Error).message, true);
        importBtn.disabled = false;
      }
    });
    updateButton();
    clear(
      preview,
      h('h3', { text: 'Vista previa' }),
      h(
        'div',
        { class: 'resumen' },
        h('span', null, h('b', { text: String(p.totalLinks) }), ' enlaces'),
        h('span', null, h('b', { text: String(p.groups.length) }), ' carpetas'),
        h('span', null, h('b', { text: String(p.duplicates) }), ' duplicados'),
        p.invalid ? h('span', null, h('b', { text: String(p.invalid) }), ' descartados (no http/https: bookmarklets, place:…)') : null,
      ),
      h('p', { class: 'ayuda', text: 'Desmarca las carpetas que no quieras. Despliega una carpeta para ver sus enlaces. Las carpetas de más de dos niveles se aplanan como «Carpeta / Subcarpeta».' }),
      ...groups,
      h('p', null, importBtn),
    );
  };

  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) {
      toast('El archivo es demasiado grande.', true);
      return;
    }
    html = slimBookmarks(await f.text());
    await loadPreview();
  });
  unwrap.addEventListener('change', () => void loadPreview());
  skipDup.addEventListener('change', () => drawPlan());

  clear(
    container,
    h(
      'div',
      { class: 'seccion' },
      h('p', { class: 'ayuda', text: 'Exporta los marcadores desde tu navegador (Chrome/Edge: Administrador de marcadores › ⋮ › Exportar; Firefox: Biblioteca › Importar y respaldar › Exportar a HTML) y elige aquí el archivo. Nada se guarda hasta que confirmes.' }),
      filePicker(file, 'Elegir archivo de marcadores…'),
      h('label', { class: 'check' }, unwrap, 'Subir un nivel el contenido de «Barra de marcadores», «Otros marcadores» y similares'),
      h('label', { class: 'check' }, skipDup, 'No importar duplicados (enlaces que ya están en WebHub o repetidos en el archivo)'),
      preview,
    ),
  );
}

// ================================================================ Copia de seguridad

function renderBackup(container: HTMLElement, reload: Reload): void {
  const file = h('input', { attrs: { type: 'file', accept: '.json,application/json' } });
  const info = h('div');
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    let data: { app?: string; exportado?: string; families?: unknown[]; links?: unknown[] };
    try {
      data = JSON.parse(await f.text());
      if (data.app !== 'WebHub' || !Array.isArray(data.families) || !Array.isArray(data.links)) throw new Error();
    } catch {
      clear(info, h('p', { class: 'error', text: 'Ese archivo no es una copia de seguridad de WebHub.' }));
      return;
    }
    const fams = data.families!.length;
    const links = data.links!.length;
    clear(
      info,
      h(
        'div',
        { class: 'resumen' },
        h('span', null, 'Copia del ', h('b', { text: data.exportado ? new Date(data.exportado).toLocaleString('es-ES') : '¿?' })),
        h('span', null, h('b', { text: String(fams) }), ' familias'),
        h('span', null, h('b', { text: String(links) }), ' enlaces'),
      ),
      h('button', {
        class: 'btn peligro',
        text: 'Sustituir todo por esta copia…',
        attrs: { type: 'button' },
        on: {
          click: () =>
            confirmDialog(
              'Restaurar copia',
              `Se borrarán las ${state.families.length} familias y ${state.links.length} enlaces actuales y se sustituirán por los de la copia. Si dudas, descarga antes una copia de lo actual.`,
              'Sustituir todo',
              () => run(() => api('POST', '/api/import/json', { data, confirm: 'SUSTITUIR' }), reload, 'Copia restaurada.'),
            ),
        },
      }),
    );
  });
  clear(
    container,
    h(
      'div',
      { class: 'seccion' },
      h('h3', { text: 'Exportar' }),
      h('p', { class: 'ayuda', text: 'Descarga todas las familias y enlaces (con notas, etiquetas, favoritos y contadores) en un archivo JSON. No incluye el PIN ni las sesiones.' }),
      h('a', { class: 'btn primario', text: 'Descargar copia (JSON)', attrs: { href: '/api/export', download: '' } }),
      h('h3', { text: 'Restaurar' }),
      h('p', { class: 'ayuda', text: 'Restaurar sustituye todo el contenido actual por el de la copia.' }),
      filePicker(file, 'Elegir copia JSON…'),
      info,
    ),
  );
}

// ================================================================ Comprobador de enlaces

interface Job { running: boolean; total: number; done: number; finishedAt?: string | null }
let pollTimer = 0;

function renderChecker(container: HTMLElement, reload: Reload): void {
  clearTimeout(pollTimer);
  const bar = h('div');
  const progress = h('div', { class: 'progreso oculto' }, bar);
  const status = h('p', { class: 'ayuda' });
  const results = h('div');
  const startBtn = h('button', { class: 'btn primario', text: `Comprobar los ${state.links.length} enlaces`, attrs: { type: 'button', disabled: state.links.length === 0 } });

  const drawResults = () => {
    const groups = { roto: [] as Link[], aviso: [] as Link[], privado: [] as Link[], protegido: [] as Link[], ignorado: [] as Link[], ok: 0, pendiente: 0 };
    for (const l of state.links) {
      const c = classify(l.checkStatus, l.url, l.checkIgnored);
      if (c === 'roto') groups.roto.push(l);
      else if (c === 'aviso') groups.aviso.push(l);
      else if (c === 'privado') groups.privado.push(l);
      else if (c === 'protegido') groups.protegido.push(l);
      else if (c === 'ignorado') groups.ignorado.push(l);
      else if (c === 'ok') groups.ok++;
      else groups.pendiente++;
    }

    const chipText = (kind: string, l: Link): string => {
      if (kind === 'privado') return 'Privado o inexistente (404)';
      if (kind === 'protegido') return `Protegida (HTTP ${l.checkStatus})`;
      return /^\d+$/.test(l.checkStatus ?? '') ? `HTTP ${l.checkStatus}` : (l.checkStatus ?? '');
    };

    const row = (l: Link, kind: 'roto' | 'aviso' | 'privado' | 'protegido' | 'ignorado') => {
      const okBtn =
        kind === 'ignorado'
          ? h('button', { class: 'btn', text: 'Volver a vigilar', attrs: { type: 'button' }, on: { click: () => run(() => api('PATCH', `/api/links/${l.id}`, { checkIgnored: false }), reload) } })
          : (kind === 'roto' || kind === 'aviso' || kind === 'privado' || kind === 'protegido')
            ? h('button', { class: 'btn', text: 'Está bien', attrs: { type: 'button' }, on: { click: () => run(() => api('PATCH', `/api/links/${l.id}`, { checkIgnored: true }), reload, 'Enlace ignorado. Puedes volver a vigilarlo en «Ignorados».') } })
            : null;
      return h(
        'tr',
        null,
        h('td', null, h('a', { text: l.title, attrs: { href: l.url, target: '_blank', rel: 'noopener noreferrer' } }), h('div', { class: 'secundario', text: l.url })),
        h('td', { text: familyLabel(l.familyId) }),
        h('td', null, h('span', { class: `chip ${kind}`, text: chipText(kind, l) })),
        h(
          'td',
          null,
          iconButton('✎', 'Editar', () => linkDialog(l, null, async () => { await reload(); })),
          iconButton('🗑', 'Borrar', () =>
            confirmDialog('Borrar enlace', `¿Borrar «${l.title}»?`, 'Borrar', () => run(() => api('DELETE', `/api/links/${l.id}`), reload)),
          ),
          okBtn,
        ),
      );
    };

    const simpleTable = (list: Link[], kind: 'roto' | 'aviso' | 'privado' | 'protegido' | 'ignorado') =>
      list.length
        ? h(
            'table',
            { class: 'tabla' },
            h('thead', null, h('tr', null, h('th', { text: 'Enlace' }), h('th', { text: 'Familia' }), h('th', { text: 'Estado' }), h('th', { text: '' }))),
            h('tbody', null, ...list.map((l) => row(l, kind))),
          )
        : null;

    // Si casi todo falla por red, lo probable es que el servidor no tenga salida a Internet.
    const network = groups.roto.filter((l) => !/^\d+$/.test(l.checkStatus ?? '')).length;
    const suspicious = network > 5 && network > state.links.length * 0.6;

    const rotoSection = groups.roto.length
      ? [h('h3', { text: `Rotos (${groups.roto.length})` }), simpleTable(groups.roto, 'roto')!]
      : [];
    const avisoSection = groups.aviso.length
      ? [h('h3', { text: `A revisar (límites de uso, errores del servidor o tiempo agotado) (${groups.aviso.length})` }), simpleTable(groups.aviso, 'aviso')!]
      : [];

    const buildDetails = (title: string, ayudaText: string, list: Link[], kind: 'privado' | 'protegido' | 'ignorado', withBulk: boolean) => {
      if (!list.length) return null;
      const nodes: any[] = [];
      nodes.push(h('summary', { text: `${title} (${list.length})` }));
      if (ayudaText) nodes.push(h('p', { class: 'ayuda', text: ayudaText }));
      if (withBulk) {
        nodes.push(h('p', null, h('button', {
          class: 'btn',
          text: 'Está bien (todos)',
          attrs: { type: 'button' },
          on: {
            click: () => confirmDialog(
              title,
              `¿Marcar los ${list.length} enlaces como correctos?`,
              'Está bien',
              async () => {
                for (const l of list) await api('PATCH', `/api/links/${l.id}`, { checkIgnored: true });
                await reload();
              },
            ),
          },
        })));
      }
      const t = simpleTable(list, kind);
      if (t) nodes.push(t);
      return h('details', null, ...nodes);
    };

    const privadoDetails = buildDetails('Posibles repositorios privados de GitHub', 'GitHub responde 404 tanto si el repositorio no existe como si es privado, y sin iniciar sesión no se puede distinguir. Si sabes que existe, márcalo como «Está bien».', groups.privado, 'privado', true);
    const protegidoDetails = buildDetails('Protegidos', 'La página responde, pero pide iniciar sesión o bloquea las comprobaciones automáticas. No está rota.', groups.protegido, 'protegido', true);
    const ignoradoDetails = buildDetails('Ignorados', '', groups.ignorado, 'ignorado', false);

    clear(
      results,
      suspicious
        ? h('p', { class: 'error', text: `${network} enlaces fallan por error de red o DNS. Es más probable que el servidor no tenga salida a Internet (o la tenga filtrada) que que estén todos rotos.` })
        : null,
      h(
        'div',
        { class: 'resumen' },
        h('span', null, h('b', { text: String(groups.ok) }), ' bien'),
        groups.protegido.length ? h('span', null, h('b', { text: String(groups.protegido.length) }), ' protegidos') : null,
        groups.privado.length ? h('span', null, h('b', { text: String(groups.privado.length) }), ' posibles privados (GitHub)') : null,
        h('span', null, h('b', { text: String(groups.aviso.length) }), ' a revisar'),
        h('span', null, h('b', { text: String(groups.roto.length) }), ' rotos'),
        groups.ignorado.length ? h('span', null, h('b', { text: String(groups.ignorado.length) }), ' ignorados') : null,
        groups.pendiente ? h('span', null, h('b', { text: String(groups.pendiente) }), ' sin comprobar') : null,
      ),
      ...rotoSection,
      ...avisoSection,
      privadoDetails,
      protegidoDetails,
      ignoradoDetails,
    );
  };


  const poll = async () => {
    try {
      const job = await api<Job>('GET', '/api/check');
      progress.classList.toggle('oculto', !job.running);
      bar.style.width = job.total ? `${Math.round((job.done / job.total) * 100)}%` : '0';
      startBtn.disabled = job.running;
      status.textContent = job.running ? `Comprobando… ${job.done} de ${job.total}` : job.finishedAt ? `Última comprobación: ${new Date(job.finishedAt).toLocaleString('es-ES')}` : '';
      if (job.running) {
        pollTimer = window.setTimeout(poll, 1000);
      } else if (job.finishedAt) {
        await reload().catch(() => {});
      }
    } catch {
      /* se reintenta al volver a la pestaña */
    }
  };

  startBtn.addEventListener('click', async () => {
    try {
      await api('POST', '/api/check');
      await poll();
    } catch (err) {
      toast((err as Error).message, true);
    }
  });

  clear(
    container,
    h(
      'div',
      { class: 'seccion' },
      h('p', { class: 'ayuda', text: 'Comprueba bajo demanda si cada enlace responde. Nunca se hace automáticamente. Algunas webs bloquean las comprobaciones automáticas o exigen login: aparecen como «protegidos». Los repositorios privados de GitHub salen como «posibles privados». Ninguno cuenta como roto.' }),
      startBtn,
      progress,
      status,
      results,
    ),
  );
  drawResults();
  void (async () => {
    const job = await api<Job>('GET', '/api/check').catch(() => null);
    if (job?.running) await poll();
    else if (job?.finishedAt) status.textContent = `Última comprobación: ${new Date(job.finishedAt).toLocaleString('es-ES')}`;
  })();
}


// ================================================================ Aspecto

function renderAspecto(container: HTMLElement, area: HTMLElement): void {
  void area;

  const temaButtons = TEMAS.map(([id, label]) => {
    const boton = h('button', { class: 'opcion-fondo', text: label, attrs: { type: 'button', 'data-tema': id, 'aria-pressed': 'false' } });
    boton.addEventListener('click', () => cambiar({ tema: id }));
    return boton;
  });

  const textoRange = h('input', { attrs: { type: 'range', min: 80, max: 200, step: 5, 'aria-label': 'Tamaño del texto' } });
  const textoValor = h('span', { class: 'secundario' });

  const fuenteButtons = FUENTES.map(([id, label]) => {
    const boton = h('button', { class: 'opcion-fuente', text: label, attrs: { type: 'button', 'data-fuente': id, 'aria-pressed': 'false' } });
    boton.addEventListener('click', () => cambiar({ fuente: id }));
    return boton;
  });

  const densidadButtons = DENSIDADES.map(([id, label]) => {
    const boton = h('button', { class: 'btn', text: label, attrs: { type: 'button', 'data-densidad': id, 'aria-pressed': 'false' } });
    boton.addEventListener('click', () => cambiar({ densidad: id }));
    return boton;
  });

  const tituloRange = h('input', { attrs: { type: 'range', min: 100, max: 220, step: 1, 'aria-label': 'Tamaño de los títulos de familia' } });
  const tituloValor = h('span', { class: 'secundario' });
  const pesoButtons = PESOS_TITULO.map(([valor, label]) => {
    const boton = h('button', { class: 'btn', text: label, attrs: { type: 'button', 'data-peso': String(valor), 'aria-pressed': 'false' } });
    boton.addEventListener('click', () => cambiar({ tituloPeso: valor }));
    return boton;
  });
  const mayusCheck = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Mayúsculas' } });
  const tituloColorInput = h('input', { attrs: { type: 'color', 'aria-label': 'Color de los títulos' } });
  const tituloColorUsar = h('button', { class: 'btn', text: 'Usar el del tema', attrs: { type: 'button' } });
  const acentoInput = h('input', { attrs: { type: 'color', 'aria-label': 'Color de acento' } });
  const acentoUsar = h('button', { class: 'btn', text: 'Usar el del tema', attrs: { type: 'button' } });

  const dominioCheck = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Mostrar el dominio' } });

  const muestras = FONDOS.map(([id, nombre]) => {
    const muestra = h('div', { class: 'muestra-fondo', attrs: { 'aria-hidden': 'true' } });
    const boton = h('button', { class: 'opcion-fondo', attrs: { type: 'button', 'aria-pressed': 'false' } }, muestra, h('span', { text: nombre }));
    boton.addEventListener('click', () => cambiar({ fondo: id }));
    return { id, muestra, boton };
  });
  const color = h('input', { attrs: { type: 'color', 'aria-label': 'Color del fondo' } });
  const fuerza = h('input', { attrs: { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Intensidad del fondo' } });
  const valor = h('span', { class: 'secundario' });

  function pintar(): void {
    const a = aspectoActual();
    for (const boton of temaButtons) {
      const activo = boton.dataset.tema === a.tema;
      boton.classList.toggle('activa', activo);
      boton.setAttribute('aria-pressed', String(activo));
    }
    textoRange.value = String(a.texto);
    textoValor.textContent = `${a.texto} %`;

    for (const boton of fuenteButtons) {
      const activo = boton.dataset.fuente === a.fuente;
      boton.classList.toggle('activa', activo);
      boton.setAttribute('aria-pressed', String(activo));
    }
    for (const boton of densidadButtons) {
      const activo = boton.dataset.densidad === a.densidad;
      boton.classList.toggle('primario', activo);
      boton.setAttribute('aria-pressed', String(activo));
    }
    tituloRange.value = String(a.tituloTamano);
    tituloValor.textContent = `${a.tituloTamano} %`;
    for (const boton of pesoButtons) {
      const activo = Number(boton.dataset.peso) === a.tituloPeso;
      boton.classList.toggle('primario', activo);
      boton.setAttribute('aria-pressed', String(activo));
    }
    mayusCheck.checked = a.tituloMayusculas;
    tituloColorInput.value = (a.tituloColor ?? a.acento ?? '#3fe0c5');
    acentoInput.value = (a.acento ?? '#3fe0c5');
    dominioCheck.checked = a.mostrarDominio;

    for (const m of muestras) {
      aplicarFondo(m.muestra, { ...a, fondo: m.id });
      m.boton.classList.toggle('activa', m.id === a.fondo);
      m.boton.setAttribute('aria-pressed', String(m.id === a.fondo));
    }
    color.value = a.color;
    fuerza.value = String(a.intensidad);
    valor.textContent = `${a.intensidad} %`;
  }

  function cambiar(parcial: Partial<Aspecto>): void {
    cambiarAspecto(parcial);
    pintar();
  }

  textoRange.addEventListener('input', () => cambiar({ texto: Number(textoRange.value) }));
  tituloRange.addEventListener('input', () => cambiar({ tituloTamano: Number(tituloRange.value) }));
  mayusCheck.addEventListener('change', () => cambiar({ tituloMayusculas: mayusCheck.checked }));
  tituloColorInput.addEventListener('input', () => cambiar({ tituloColor: tituloColorInput.value }));
  tituloColorUsar.addEventListener('click', () => cambiar({ tituloColor: null }));
  acentoInput.addEventListener('input', () => cambiar({ acento: acentoInput.value }));
  acentoUsar.addEventListener('click', () => cambiar({ acento: null }));
  dominioCheck.addEventListener('change', () => cambiar({ mostrarDominio: dominioCheck.checked }));
  color.addEventListener('input', () => cambiar({ color: color.value }));
  fuerza.addEventListener('input', () => cambiar({ intensidad: Number(fuerza.value) }));

  clear(
    container,
    h('p', { class: 'ayuda', text: 'Los cambios se ven al momento y se guardan en el servidor: valen en todos tus dispositivos.' }),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Tema' }),
      h('div', { class: 'opciones-fondo' }, ...temaButtons),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Tamaño del texto' }),
      h('div', { class: 'fila-rango' }, textoRange, textoValor),
      h('p', { text: 'Aa Ejemplo de enlace' }),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Fuente' }),
      h('div', { class: 'opciones-fondo' }, ...fuenteButtons),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Densidad' }),
      h('div', { class: 'opciones-fondo' }, ...densidadButtons),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Títulos de familia' }),
      h('div', { class: 'fila-rango' }, tituloRange, tituloValor),
      h('div', { class: 'opciones-fondo' }, ...pesoButtons),
      h('label', { class: 'check' }, mayusCheck, 'Mayúsculas'),
      h('div', { class: 'ajustes-fondo' },
        h('label', { class: 'etiqueta' }, 'Color'),
        h('div', { class: 'fila-rango' }, tituloColorInput, tituloColorUsar),
      ),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Color de acento' }),
      h('div', { class: 'fila-rango' }, acentoInput, acentoUsar),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Enlaces' }),
      h('label', { class: 'check' }, dominioCheck, 'Mostrar el dominio junto a cada enlace'),
    ),
    h('div', { class: 'seccion' },
      h('h3', { text: 'Fondo del área central' }),
      h('div', { class: 'opciones-fondo' }, ...muestras.map((m) => m.boton)),
      h('div', { class: 'ajustes-fondo' },
        h('label', { class: 'etiqueta' }, 'Color'),
        color,
        h('label', { class: 'etiqueta' }, 'Intensidad'),
        h('div', { class: 'fila-rango' }, fuerza, valor),
      ),
    ),
    h('div', { class: 'seccion' },
      h('button', { class: 'btn peligro', text: 'Restablecer todo', attrs: { type: 'button' }, on: { click: () => cambiar(ASPECTO_INICIAL) } }),
    ),
  );

  pintar();
}

// ================================================================ Acceso (passkeys / huellas)

function fechaLocal(iso: string): string {
  return new Date(iso).toLocaleString('es-ES');
}

function renderAcceso(container: HTMLElement): void {
  interface Credencial { id: string; name: string; createdAt: string; lastUsedAt: string | null }
  interface AccesoEntrada { id: number; at: string; kind: string; ok: 0 | 1; ip: string; device: string; detail: string }
  interface AccesoResp { entries: AccesoEntrada[]; omitted: number }

  let creds: Credencial[] = [];
  let loading = true;
  let loadError: string | null = null;
  let pinEnabled = true;

  const listWrap = h('div');
  const activationWrap = h('div');
  const pinWrap = h('div');
  const regWrap = h('div');

  const drawList = () => {
    clear(listWrap);
    if (loading) {
      listWrap.append(h('p', { class: 'ayuda', text: 'Cargando…' }));
      return;
    }
    if (loadError) {
      listWrap.append(h('p', { class: 'error', text: loadError }));
      return;
    }
    if (creds.length === 0) {
      listWrap.append(h('p', { class: 'ayuda', text: 'Todavía no hay ninguna huella registrada.' }));
      return;
    }
    for (const c of creds) {
      const btn = h('button', {
        class: 'btn peligro',
        text: 'Borrar',
        attrs: { type: 'button' },
        on: {
          click: () => {
            confirmDialog(
              'Borrar huella',
              `¿Borrar la huella «${c.name}»?`,
              'Borrar',
              async () => {
                try {
                  await api('DELETE', `/api/webauthn/credentials/${encodeURIComponent(c.id)}`);
                  await loadCreds();
                  if (creds.length === 0) markDevicePasskey(false);
                  toast('Huella borrada.');
                } catch (err) {
                  toast((err as Error).message, true);
                  throw err;
                }
              },
            );
          },
        },
      });
      const row = h(
        'div',
        { class: 'fila-admin fila-acceso' },
        h('span', { class: 'texto', text: c.name }),
        h('span', { class: 'secundario', text: `Alta: ${fechaLocal(c.createdAt)}` }),
        h('span', { class: 'secundario', text: `Último uso: ${c.lastUsedAt ? fechaLocal(c.lastUsedAt) : 'nunca'}` }),
        h('span', { class: 'acc' }, btn),
      );
      listWrap.append(row);
    }
  };

  const loadCreds = async () => {
    loading = true;
    loadError = null;
    drawList();
    try {
      creds = await api<Credencial[]>('GET', '/api/webauthn/credentials');
    } catch (err) {
      loadError = (err as Error).message;
      toast(loadError, true);
      creds = [];
    } finally {
      loading = false;
      drawList();
      drawPin();
    }
  };

  const drawPin = () => {
    clear(pinWrap);
    const btn = h('button', {
      class: pinEnabled ? 'btn peligro' : 'btn primario',
      text: pinEnabled ? 'Desactivar la entrada con PIN (solo huella)' : 'Reactivar la entrada con PIN',
      attrs: { type: 'button' },
    });
    if (pinEnabled && creds.length === 0) {
      btn.disabled = true;
      pinWrap.append(btn, h('p', { class: 'ayuda', text: 'Registra antes una huella.' }));
    } else {
      pinWrap.append(btn);
    }
    btn.addEventListener('click', async () => {
      if (pinEnabled) {
        confirmDialog('Desactivar entrada con PIN', 'Nadie podrá entrar con PIN, ni tú. Si pierdes todos los dispositivos con huella tendrás que reactivarlo en el servidor con «npm run pin».', 'Desactivar', async () => {
          try {
            const r = await api<{ pin: boolean }>('PUT', '/api/acceso/pin', { enabled: false });
            pinEnabled = r.pin;
            await loadCreds();
            drawPin();
          } catch (err) {
            toast((err as Error).message, true);
            throw err;
          }
        });
      } else {
        btn.disabled = true;
        try {
          const r = await api<{ pin: boolean }>('PUT', '/api/acceso/pin', { enabled: true });
          pinEnabled = r.pin;
          drawPin();
        } catch (err) {
          toast((err as Error).message, true);
        } finally {
          btn.disabled = false;
        }
      }
    });
  };

  const loadPinState = async () => {
    try {
      const s = await api<{ authenticated: boolean; configured: boolean; passkeys: boolean; pin: boolean }>('GET', '/api/session');
      pinEnabled = !!s.pin;
    } catch {
      pinEnabled = true;
    }
    drawPin();
  };

  const etiquetaEvento = (e: AccesoEntrada): string => {
    switch (e.kind) {
      case 'pin':
        if (e.ok) return 'Entrada con PIN';
        return e.detail === 'PIN desactivado' ? 'PIN desactivado' : 'PIN incorrecto';
      case 'huella':
        if (e.ok) return e.detail ? `Entrada con huella (${e.detail})` : 'Entrada con huella';
        return 'Huella no válida';
      case 'bloqueo':
        return e.detail ? `Bloqueo de entrada: ${e.detail}` : 'Bloqueo de entrada';
      case 'huella-alta':
        return e.detail ? `Huella añadida (${e.detail})` : 'Huella añadida';
      case 'huella-baja':
        return e.detail ? `Huella borrada (${e.detail})` : 'Huella borrada';
      case 'pin-desactivado':
        return 'Entrada con PIN desactivada';
      case 'pin-activado':
        return 'Entrada con PIN reactivada';
      default:
        return e.kind;
    }
  };

  const drawReg = (entries: AccesoEntrada[], omitted: number) => {
    clear(regWrap);
    const failed24 = entries.filter((e) => e.ok === 0 && Date.now() - new Date(e.at).getTime() <= 24 * 60 * 60 * 1000).length;
    const lastOk = entries.find((e) => e.ok === 1);
    let summaryText = 'Todavía no hay accesos registrados.';
    if (entries.length > 0) {
      if (lastOk) summaryText = `Último acceso correcto: ${fechaLocal(lastOk.at)} · ${lastOk.device} · ${lastOk.ip}`;
      else summaryText = 'Todavía no hay accesos registrados.';
    }
    regWrap.append(h('p', { class: 'ayuda', text: summaryText }));
    regWrap.append(h('p', { class: 'ayuda', text: `${failed24} intentos fallidos en las últimas 24 horas` }));
    if (omitted > 0) {
      regWrap.append(h('p', { class: 'ayuda', text: `Además se han omitido ${omitted} intentos fallidos por exceso de volumen (protección del registro).` }));
    }
    const tbody = h('tbody', null, ...entries.map((e) =>
      h(
        'tr',
        null,
        h('td', { text: fechaLocal(e.at) }),
        h('td', { text: etiquetaEvento(e) }),
        h('td', null, h('span', { class: e.ok ? 'chip ok' : 'chip roto', text: e.ok ? 'Correcto' : 'Fallido' })),
        h('td', { text: e.ip }),
        h('td', { text: e.device }),
      ),
    ));
    const table = h(
      'table',
      { class: 'tabla' },
      h('thead', null, h('tr', null, h('th', { text: 'Fecha' }), h('th', { text: 'Evento' }), h('th', { text: 'Resultado' }), h('th', { text: 'IP' }), h('th', { text: 'Dispositivo' }))),
      tbody,
    );
    const actualizar = h('button', { class: 'btn', text: 'Actualizar', attrs: { type: 'button' }, on: { click: () => void loadReg() } });
    regWrap.append(table, h('p', null, actualizar));
  };

  const loadReg = async () => {
    try {
      const r = await api<AccesoResp>('GET', '/api/accesos?limite=50');
      drawReg(r.entries ?? [], r.omitted ?? 0);
    } catch (err) {
      clear(regWrap, h('p', { class: 'error', text: (err as Error).message }));
    }
  };

  const seccionHuellas = h(
    'div',
    { class: 'seccion' },
    h('h3', { text: 'Entrada con huella' }),
    h('p', {
      class: 'ayuda',
      text: `La huella (o cara, o Windows Hello) se queda en el dispositivo y el servidor solo guarda una clave pública; el PIN sigue valiendo y sirve para dar de alta cada dispositivo nuevo; las huellas quedan atadas al dominio actual (${location.hostname}).`,
    }),
    listWrap,
    activationWrap,
    h('p', {
      class: 'ayuda',
      text: 'El PIN se cambia en el servidor con «npm run pin» (con Docker: docker compose run --rm webhub npm run pin). Al cambiarlo se cierran todas las sesiones, pero las huellas siguen valiendo.',
    }),
  );

  const seccionPin = h('div', { class: 'seccion' }, h('h3', { text: 'Entrada con PIN' }), pinWrap);

  const seccionReg = h('div', { class: 'seccion' }, h('h3', { text: 'Registro de accesos' }), regWrap);

  clear(container, seccionHuellas, seccionPin, seccionReg);

  // Se comprueba soporte antes de mostrar el botón de activación.
  void (async () => {
    const supported = passkeysSupported() && (await platformAvailable());
    clear(activationWrap);
    if (!supported) {
      activationWrap.append(h('p', { class: 'ayuda', text: 'Este navegador o dispositivo no admite entrar con huella. Usa el PIN.' }));
      return;
    }
    const nameInput = h('input', {
      class: 'campo',
      attrs: { type: 'text', value: defaultDeviceName(), maxlength: 60, 'aria-label': 'Nombre del dispositivo' },
    });
    const activateBtn = h('button', {
      class: 'btn primario',
      text: 'Activar huella en este dispositivo',
      attrs: { type: 'button' },
    });
    activateBtn.addEventListener('click', async () => {
      const nombre = nameInput.value.trim();
      if (!nombre) {
        toast('Pon un nombre al dispositivo.', true);
        return;
      }
      activateBtn.disabled = true;
      try {
        await registerPasskey(nombre);
        document.querySelector('.aviso-huella')?.remove();
        toast('Huella activada.');
        await loadCreds();
      } catch (err) {
        toast((err as Error).message, true);
      } finally {
        activateBtn.disabled = false;
      }
    });
    activationWrap.append(nameInput, h('p', null, activateBtn));
  })();

  void (async () => {
    await loadCreds();
    await loadPinState();
    await loadReg();
  })();
}

