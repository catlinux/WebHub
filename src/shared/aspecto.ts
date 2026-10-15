/** Aspecto del área central: fondo decorativo, color y fuerza. Se guarda en el navegador, no en el servidor. */

export const FONDOS = [
  ['ninguno', 'Liso'],
  ['cuadricula', 'Cuadrícula'],
  ['puntos', 'Puntos'],
  ['resplandor', 'Resplandor'],
  ['aurora', 'Aurora'],
] as const;

export type Fondo = (typeof FONDOS)[number][0];

export interface Aspecto {
  fondo: Fondo;
  /** Color del tinte, `#rrggbb`. */
  color: string;
  /** De 0 (invisible) a 100. */
  intensidad: number;
}

export const ASPECTO_INICIAL: Aspecto = { fondo: 'puntos', color: '#3fe0c5', intensidad: 50 };

/** Lee un valor guardado sin fiarse de él: lo que no es válido vuelve al valor inicial. */
export function parseAspecto(raw: string | null | undefined): Aspecto {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    /* sin datos guardados */
  }
  const fondo = FONDOS.find(([id]) => id === data.fondo)?.[0] ?? ASPECTO_INICIAL.fondo;
  const color = typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color) ? data.color.toLowerCase() : ASPECTO_INICIAL.color;
  const intensidad =
    typeof data.intensidad === 'number' && Number.isFinite(data.intensidad)
      ? Math.max(0, Math.min(100, Math.round(data.intensidad)))
      : ASPECTO_INICIAL.intensidad;
  return { fondo, color, intensidad };
}

/** `#3fe0c5` → `63, 224, 197`, para usarlo dentro de `rgba()` en CSS. */
export function rgbDe(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
