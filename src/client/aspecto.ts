import { parseAspecto, rgbDe, aspectoCss, ASPECTO_INICIAL, type Aspecto } from '../shared/aspecto.ts';
import { api } from './api.ts';
import { toast } from './dom.ts';

let actual: Aspecto = ASPECTO_INICIAL;
let guardadoTimer = 0;

export function aspectoActual(): Aspecto {
  return actual;
}

export function aplicarFondo(el: HTMLElement, a: Aspecto): void {
  el.dataset.fondo = a.fondo;
  el.style.setProperty('--tinte', rgbDe(a.color));
  el.style.setProperty('--int', String(a.intensidad / 100));
}

export function aplicarAspecto(a: Aspecto = actual): void {
  const { atributos, variables } = aspectoCss(a);
  const html = document.documentElement;
  for (const [clave, valor] of Object.entries(atributos)) html.setAttribute(clave, valor);
  for (const [clave, valor] of Object.entries(variables)) {
    if (valor === null) html.style.removeProperty(clave);
    else html.style.setProperty(clave, valor);
  }
  const contenido = document.querySelector('.contenido') as HTMLElement | null;
  if (contenido) aplicarFondo(contenido, a);
}

export async function cargarAspecto(): Promise<Aspecto> {
  try {
    localStorage.removeItem('webhub.aspecto');
  } catch {
    /* sin almacenamiento local */
  }
  let resultado = ASPECTO_INICIAL;
  try {
    const datos = await api<unknown>('GET', '/api/aspecto');
    resultado = parseAspecto(typeof datos === 'string' ? datos : JSON.stringify(datos ?? null));
  } catch {
    resultado = ASPECTO_INICIAL;
  }
  actual = resultado;
  aplicarAspecto(actual);
  return actual;
}

export function cambiarAspecto(parcial: Partial<Aspecto>): void {
  actual = { ...actual, ...parcial };
  aplicarAspecto(actual);
  window.clearTimeout(guardadoTimer);
  guardadoTimer = window.setTimeout(async () => {
    try {
      await api('PUT', '/api/aspecto', actual);
    } catch (err) {
      toast((err as Error).message, true);
    }
  }, 400);
}