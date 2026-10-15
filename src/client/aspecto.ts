import { parseAspecto, rgbDe, type Aspecto } from '../shared/aspecto.ts';

const CLAVE = 'webhub.aspecto';

export function cargarAspecto(): Aspecto {
  try {
    return parseAspecto(localStorage.getItem(CLAVE));
  } catch {
    return parseAspecto(null);
  }
}

export function guardarAspecto(aspecto: Aspecto): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(aspecto));
  } catch {
    /* sin almacenamiento local: el cambio dura hasta recargar */
  }
}

/** Las variables se fijan por CSSOM (permitido por la CSP); el dibujo del fondo está en styles.css. */
export function aplicarAspecto(el: HTMLElement, aspecto: Aspecto = cargarAspecto()): void {
  el.dataset.fondo = aspecto.fondo;
  el.style.setProperty('--tinte', rgbDe(aspecto.color));
  el.style.setProperty('--int', String(aspecto.intensidad / 100));
}
