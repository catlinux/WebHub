/** Utilidades mínimas para crear DOM sin innerHTML (evita inyecciones). */

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  data?: Record<string, string | number>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.title) el.title = props.title;
    for (const [k, v] of Object.entries(props.attrs ?? {})) {
      if (v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const [k, v] of Object.entries(props.data ?? {})) el.dataset[k] = String(v);
    for (const [k, fn] of Object.entries(props.on ?? {})) el.addEventListener(k, fn as EventListener);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === 'number' ? String(c) : c);
  return el;
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren(...(children.filter((c) => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'number' ? String(c) : c)) as (Node | string)[]));
}

let toastTimer = 0;
/** Mensaje breve en la parte inferior. */
export function toast(message: string, isError = false): void {
  document.querySelector('.aviso-flotante')?.remove();
  const el = h('div', { class: `aviso-flotante${isError ? ' error' : ''}`, text: message, attrs: { role: 'status' } });
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

/** Icono de un dominio: favicon cacheado por el servidor o, si falla, su inicial. */
export function favicon(domain: string): HTMLElement {
  const letter = () => h('span', { class: 'fav letra', text: (domain[0] ?? '?').toUpperCase(), attrs: { 'aria-hidden': 'true' } });
  if (!domain) return letter();
  const img = h('img', { class: 'fav', attrs: { src: `/icon/${encodeURIComponent(hostFromDomain(domain))}`, alt: '', loading: 'lazy', width: 16, height: 16 } });
  img.addEventListener('error', () => img.replaceWith(letter()), { once: true });
  return img;
}

// El dominio visible quita «www.»; el servidor necesita el host real.
const hosts = new Map<string, string>();
export function rememberHost(domain: string, url: string): void {
  try {
    hosts.set(domain, new URL(url).hostname);
  } catch {
    /* nada */
  }
}
function hostFromDomain(domain: string): string {
  return hosts.get(domain) ?? domain;
}
