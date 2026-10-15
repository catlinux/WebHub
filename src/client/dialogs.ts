import { h } from './dom.ts';
import { api } from './api.ts';
import { state, topFamilies, childrenOf, familyLabel } from './state.ts';
import type { Family, Link } from '../shared/types.ts';

/** Diálogo modal genérico: ejecuta `submit` y muestra el error sin cerrarse si falla. */
export function openDialog(opts: {
  title: string;
  body: Node[];
  submitLabel?: string;
  danger?: boolean;
  submit: () => Promise<void>;
}): void {
  const error = h('div', { class: 'error', attrs: { role: 'alert' } });
  const submitBtn = h('button', { class: `btn ${opts.danger ? 'peligro' : 'primario'}`, text: opts.submitLabel ?? 'Guardar', attrs: { type: 'submit' } });
  const dialog = h('dialog');
  const form = h(
    'form',
    { attrs: { method: 'dialog', novalidate: true } },
    h('h3', { text: opts.title }),
    ...opts.body,
    error,
    h('div', { class: 'acciones' }, h('button', { class: 'btn', text: 'Cancelar', attrs: { type: 'button' }, on: { click: () => dialog.close() } }), submitBtn),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submitBtn.disabled = true;
    error.textContent = '';
    try {
      await opts.submit();
      dialog.close();
    } catch (err) {
      error.textContent = (err as Error).message;
    } finally {
      submitBtn.disabled = false;
    }
  });
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  (form.querySelector('input:not([type=checkbox]), select, textarea') as HTMLElement | null)?.focus();
}

export function confirmDialog(title: string, message: string, action: string, run: () => Promise<void>): void {
  openDialog({ title, body: [h('p', { text: message })], submitLabel: action, danger: true, submit: run });
}

function field(label: string, input: HTMLElement): HTMLElement[] {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return [h('label', { class: 'etiqueta', text: label, attrs: { for: id } }), input];
}

function familySelect(selected: number | null, opts: { includeNone?: string; onlyTop?: boolean; exclude?: number } = {}): HTMLSelectElement {
  const select = h('select', { class: 'campo' });
  if (opts.includeNone) select.append(h('option', { text: opts.includeNone, attrs: { value: '' } }));
  for (const f of topFamilies()) {
    if (f.id === opts.exclude) continue;
    select.append(h('option', { text: f.name, attrs: { value: f.id, selected: f.id === selected } }));
    if (opts.onlyTop) continue;
    for (const c of childrenOf(f.id)) {
      select.append(h('option', { text: `   ${f.name} › ${c.name}`, attrs: { value: c.id, selected: c.id === selected } }));
    }
  }
  return select;
}

/** Crear o editar un enlace. */
export function linkDialog(link: Link | null, defaultFamily: number | null, onDone: () => Promise<void>): void {
  if (state.families.length === 0) {
    familyDialog(null, null, onDone);
    return;
  }
  const url = h('input', { class: 'campo', attrs: { type: 'text', inputmode: 'url', placeholder: 'https://…', required: true, value: link?.url ?? '', autocomplete: 'off' } });
  const title = h('input', { class: 'campo', attrs: { type: 'text', placeholder: 'Si lo dejas vacío se usa el dominio', value: link?.title ?? '', maxlength: 300 } });
  const family = familySelect(link?.familyId ?? defaultFamily ?? topFamilies()[0]?.id ?? null);
  const tags = h('input', { class: 'campo', attrs: { type: 'text', placeholder: 'separadas por comas', value: link?.tags.join(', ') ?? '' } });
  const note = h('input', { class: 'campo', attrs: { type: 'text', placeholder: 'Nota corta (opcional)', value: link?.note ?? '', maxlength: 500 } });
  const fav = h('input', { attrs: { type: 'checkbox', checked: link?.favorite ?? false } });
  openDialog({
    title: link ? 'Editar enlace' : 'Nuevo enlace',
    body: [
      ...field('URL', url),
      ...field('Título', title),
      ...field('Familia', family),
      ...field('Etiquetas', tags),
      ...field('Nota', note),
      h('label', { class: 'check' }, fav, 'Favorito'),
    ],
    submitLabel: link ? 'Guardar' : 'Añadir',
    submit: async () => {
      const body = { url: url.value, title: title.value, familyId: Number(family.value), tags: tags.value, note: note.value, favorite: fav.checked };
      if (link) await api('PATCH', `/api/links/${link.id}`, body);
      else await api('POST', '/api/links', body);
      await onDone();
    },
  });
}

/** Crear o editar una familia (o subfamilia). */
export function familyDialog(family: Family | null, parentId: number | null, onDone: () => Promise<void>): void {
  const name = h('input', { class: 'campo', attrs: { type: 'text', required: true, value: family?.name ?? '', maxlength: 80, placeholder: 'Proveedores, Redes, Mis webs…' } });
  const hasKids = family ? childrenOf(family.id).length > 0 : false;
  const parent = familySelect(family ? family.parentId : parentId, { includeNone: '— Ninguna (familia principal) —', onlyTop: true, exclude: family?.id });
  const collapsedCb = h('input', { attrs: { type: 'checkbox', checked: family?.collapsed ?? false } });
  const body: Node[] = [...field('Nombre', name)];
  if (!hasKids) body.push(...field('Dentro de', parent));
  body.push(h('label', { class: 'check' }, collapsedCb, 'Mostrar sus enlaces plegados por defecto'));
  body.push(h('p', { class: 'ayuda', text: 'Con la flecha ▾ puedes desplegarla en cada dispositivo.' }));
  openDialog({
    title: family ? `Editar «${family.name}»` : parentId ? `Nueva subfamilia de «${familyLabel(parentId)}»` : 'Nueva familia',
    body,
    submitLabel: family ? 'Guardar' : 'Crear',
    submit: async () => {
      const body: Record<string, unknown> = { name: name.value, collapsed: collapsedCb.checked };
      if (!hasKids) body.parentId = parent.value ? Number(parent.value) : null;
      if (family) await api('PATCH', `/api/families/${family.id}`, body);
      else await api('POST', '/api/families', body);
      await onDone();
    },
  });
}
