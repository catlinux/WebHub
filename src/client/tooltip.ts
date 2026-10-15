/** Tooltip propio para los enlaces: sustituye al `title` nativo, que no se puede estilar. */

let tip: HTMLElement | null = null;
let timer = 0;

export function hideTooltip(): void {
  clearTimeout(timer);
  tip?.remove();
  tip = null;
}

function show(target: HTMLElement, content: HTMLElement): void {
  hideTooltip();
  tip = content;
  tip.classList.add('tooltip');
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  const left = Math.max(8, Math.min(r.left + 14, window.innerWidth - w - 8));
  const below = r.bottom + 6;
  const top = below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 6) : below;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

/** Muestra `build(elemento)` junto a cada `a.link` bajo `root` tras una pausa. No hace nada en pantallas táctiles. */
export function attachTooltips(root: HTMLElement, build: (anchor: HTMLElement) => HTMLElement | null): void {
  if (!window.matchMedia('(hover: hover)').matches) return;
  const anchorOf = (ev: Event) => (ev.target as HTMLElement).closest?.('a.link') as HTMLElement | null;
  root.addEventListener('mouseover', (ev) => {
    const a = anchorOf(ev);
    if (!a || a.contains(ev.relatedTarget as Node | null)) return;
    hideTooltip();
    timer = window.setTimeout(() => {
      const content = a.isConnected ? build(a) : null;
      if (content) show(a, content);
    }, 450);
  });
  root.addEventListener('mouseout', (ev) => {
    const a = anchorOf(ev);
    if (a && !a.contains(ev.relatedTarget as Node | null)) hideTooltip();
  });
  root.addEventListener('scroll', hideTooltip, true);
  root.addEventListener('click', hideTooltip);
  document.addEventListener('keydown', hideTooltip);
}
