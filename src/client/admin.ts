import { h, clear, toast, favicon } from './dom.ts';
import { api } from './api.ts';
import { state, topFamilies, childrenOf, familyById, linksOf, countFamily, familyLabel } from './state.ts';
import { linkDialog, familyDialog, confirmDialog } from './dialogs.ts';
import { dropReorder, moveItem } from '../shared/order.ts';
import { classify } from '../shared/check.ts';
import { FONDOS, ASPECTO_INICIAL, type Aspecto } from '../shared/aspecto.ts';
import { cargarAspecto, guardarAspecto, aplicarAspecto } from './aspecto.ts';
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
    const groups = { roto: [] as Link[], aviso: [] as Link[], ok: 0, pendiente: 0 };
    for (const l of state.links) {
      const c = classify(l.checkStatus);
      if (c === 'roto') groups.roto.push(l);
      else if (c === 'aviso') groups.aviso.push(l);
      else if (c === 'ok') groups.ok++;
      else groups.pendiente++;
    }
    const table = (title: string, kind: 'roto' | 'aviso', list: Link[]) =>
      list.length
        ? [
            h('h3', { text: `${title} (${list.length})` }),
            h(
              'table',
              { class: 'tabla' },
              h('thead', null, h('tr', null, h('th', { text: 'Enlace' }), h('th', { text: 'Familia' }), h('th', { text: 'Estado' }), h('th', { text: '' }))),
              h(
                'tbody',
                null,
                ...list.map((l) =>
                  h(
                    'tr',
                    null,
                    h('td', null, h('a', { text: l.title, attrs: { href: l.url, target: '_blank', rel: 'noopener noreferrer' } }), h('div', { class: 'secundario', text: l.url })),
                    h('td', { text: familyLabel(l.familyId) }),
                    h('td', null, h('span', { class: `chip ${kind}`, text: /^\d+$/.test(l.checkStatus ?? '') ? `HTTP ${l.checkStatus}` : (l.checkStatus ?? '') })),
                    h(
                      'td',
                      null,
                      iconButton('✎', 'Editar', () => linkDialog(l, null, async () => { await reload(); })),
                      iconButton('🗑', 'Borrar', () =>
                        confirmDialog('Borrar enlace', `¿Borrar «${l.title}»?`, 'Borrar', () => run(() => api('DELETE', `/api/links/${l.id}`), reload)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ]
        : [];
    // Si casi todo falla por red, lo probable es que el servidor no tenga salida a Internet.
    const network = groups.roto.filter((l) => !/^\d+$/.test(l.checkStatus ?? '')).length;
    const suspicious = network > 5 && network > state.links.length * 0.6;
    clear(
      results,
      suspicious
        ? h('p', { class: 'error', text: `${network} enlaces fallan por error de red o DNS. Es más probable que el servidor no tenga salida a Internet (o la tenga filtrada) que que estén todos rotos.` })
        : null,
      h(
        'div',
        { class: 'resumen' },
        h('span', null, h('b', { text: String(groups.ok) }), ' bien'),
        h('span', null, h('b', { text: String(groups.aviso.length) }), ' a revisar'),
        h('span', null, h('b', { text: String(groups.roto.length) }), ' rotos'),
        groups.pendiente ? h('span', null, h('b', { text: String(groups.pendiente) }), ' sin comprobar') : null,
      ),
      ...table('Rotos', 'roto', groups.roto),
      ...table('A revisar (requieren login, limitan peticiones o dan error del servidor)', 'aviso', groups.aviso),
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
      h('p', { class: 'ayuda', text: 'Comprueba bajo demanda si cada enlace responde. Nunca se hace automáticamente. Algunas webs bloquean las comprobaciones automáticas o exigen login: aparecen como «a revisar», no como rotas.' }),
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
  let actual = cargarAspecto();
  const muestras = FONDOS.map(([id, nombre]) => {
    const muestra = h('div', { class: 'muestra-fondo', attrs: { 'aria-hidden': 'true' } });
    const boton = h('button', { class: 'opcion-fondo', attrs: { type: 'button' } }, muestra, h('span', { text: nombre }));
    boton.addEventListener('click', () => cambiar({ fondo: id }));
    return { id, muestra, boton };
  });
  const color = h('input', { attrs: { type: 'color', 'aria-label': 'Color del fondo' } });
  const fuerza = h('input', { attrs: { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Intensidad del fondo' } });
  const valor = h('span', { class: 'secundario' });

  function pintar(): void {
    aplicarAspecto(area, actual);
    for (const m of muestras) {
      aplicarAspecto(m.muestra, { ...actual, fondo: m.id });
      m.boton.classList.toggle('activa', m.id === actual.fondo);
      m.boton.setAttribute('aria-pressed', String(m.id === actual.fondo));
    }
    color.value = actual.color;
    fuerza.value = String(actual.intensidad);
    valor.textContent = `${actual.intensidad} %`;
  }
  function cambiar(parcial: Partial<Aspecto>): void {
    actual = { ...actual, ...parcial };
    guardarAspecto(actual);
    pintar();
  }
  color.addEventListener('input', () => cambiar({ color: color.value }));
  fuerza.addEventListener('input', () => cambiar({ intensidad: Number(fuerza.value) }));

  clear(
    container,
    h(
      'div',
      { class: 'seccion' },
      h('h3', { text: 'Fondo del área central' }),
      h('p', { class: 'ayuda', text: 'Un fondo discreto detrás de las listas. Se ve al momento y se guarda en este navegador: en cada dispositivo se configura por separado.' }),
      h('div', { class: 'opciones-fondo' }, ...muestras.map((m) => m.boton)),
      h('div', { class: 'ajustes-fondo' },
        h('label', { class: 'etiqueta' }, 'Color'),
        color,
        h('label', { class: 'etiqueta' }, 'Intensidad'),
        h('div', { class: 'fila-rango' }, fuerza, valor),
      ),
      h('button', { class: 'btn', text: 'Restablecer', attrs: { type: 'button' }, on: { click: () => cambiar(ASPECTO_INICIAL) } }),
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

  let creds: Credencial[] = [];
  let loading = true;
  let loadError: string | null = null;

  const listWrap = h('div');
  const activationWrap = h('div');

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
                }
              },
            );
          },
        },
      });
      const row = h(
        'div',
        { class: 'fila-admin' },
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
    }
  };

  clear(
    container,
    h(
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
    ),
  );

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

  void loadCreds();
}
