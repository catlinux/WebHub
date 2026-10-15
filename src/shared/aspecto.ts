/** Aspecto de la aplicación: tema, fuente, densidad, tamaño de texto, títulos y fondo del área central. Los valores acaban en CSS, así que se validan de forma estricta. */

export const FONDOS = [
  ['ninguno', 'Liso'],
  ['cuadricula', 'Cuadrícula'],
  ['puntos', 'Puntos'],
  ['resplandor', 'Resplandor'],
  ['aurora', 'Aurora'],
] as const;

export type Fondo = (typeof FONDOS)[number][0];

export const TEMAS = [
  ['oscuro', 'Oscuro'],
  ['contraste', 'Alto contraste'],
  ['claro', 'Claro'],
] as const;

export type Tema = (typeof TEMAS)[number][0];

export const FUENTES = [
  ['sistema', 'Sistema'],
  ['verdana', 'Verdana (muy legible)'],
  ['humanista', 'Humanista (Trebuchet o Segoe)'],
  ['serif', 'Con serifa'],
  ['mono', 'Monoespaciada'],
] as const;

export type Fuente = (typeof FUENTES)[number][0];

export const DENSIDADES = [
  ['compacta', 'Compacta'],
  ['normal', 'Normal'],
  ['comoda', 'Cómoda'],
] as const;

export type Densidad = (typeof DENSIDADES)[number][0];

export const PESOS_TITULO = [
  [400, 'Normal'],
  [600, 'Seminegrita'],
  [700, 'Negrita'],
  [800, 'Extranegrita'],
] as const;

export type PesoTitulo = (typeof PESOS_TITULO)[number][0];

export interface Aspecto {
  fondo: Fondo;
  /** Color del tinte, `#rrggbb`. */
  color: string;
  /** De 0 (invisible) a 100. */
  intensidad: number;
  tema: Tema;
  fuente: Fuente;
  densidad: Densidad;
  /** Porcentaje del tamaño del texto de toda la aplicación (80-200). */
  texto: number;
  /** Porcentaje del tamaño de los títulos de familia (100-220). */
  tituloTamano: number;
  /** Peso de los títulos. */
  tituloPeso: PesoTitulo;
  /** Si los títulos se muestran en mayúsculas. */
  tituloMayusculas: boolean;
  /** Color de los títulos, `#rrggbb`, o null para usar el del tema. */
  tituloColor: string | null;
  /** Color de acento, `#rrggbb`, o null para usar el del tema. */
  acento: string | null;
  /** Si se muestra el dominio. */
  mostrarDominio: boolean;
}

export const ASPECTO_INICIAL: Aspecto = {
  fondo: 'puntos',
  color: '#3fe0c5',
  intensidad: 50,
  tema: 'oscuro',
  fuente: 'sistema',
  densidad: 'normal',
  texto: 100,
  tituloTamano: 120,
  tituloPeso: 700,
  tituloMayusculas: true,
  tituloColor: null,
  acento: null,
  mostrarDominio: true,
};

/** Lee un valor guardado sin fiarse de él: lo que no es válido vuelve al valor inicial. */
export function parseAspecto(raw: string | null | undefined): Aspecto {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* sin datos guardados */
  }

  const colorValido = (v: unknown): string | null =>
    typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;

  const fondo =
    FONDOS.find(([id]) => id === data.fondo)?.[0] ?? ASPECTO_INICIAL.fondo;
  const color = colorValido(data.color) ?? ASPECTO_INICIAL.color;
  const intensidad =
    typeof data.intensidad === 'number' && Number.isFinite(data.intensidad)
      ? Math.max(0, Math.min(100, Math.round(data.intensidad)))
      : ASPECTO_INICIAL.intensidad;

  const tema =
    TEMAS.find(([id]) => id === data.tema)?.[0] ?? ASPECTO_INICIAL.tema;
  const fuente =
    FUENTES.find(([id]) => id === data.fuente)?.[0] ?? ASPECTO_INICIAL.fuente;
  const densidad =
    DENSIDADES.find(([id]) => id === data.densidad)?.[0] ??
    ASPECTO_INICIAL.densidad;

  const texto =
    typeof data.texto === 'number' && Number.isFinite(data.texto)
      ? Math.max(80, Math.min(200, Math.round(data.texto)))
      : ASPECTO_INICIAL.texto;
  const tituloTamano =
    typeof data.tituloTamano === 'number' && Number.isFinite(data.tituloTamano)
      ? Math.max(100, Math.min(220, Math.round(data.tituloTamano)))
      : ASPECTO_INICIAL.tituloTamano;
  const tituloPeso =
    PESOS_TITULO.find(([n]) => n === data.tituloPeso)?.[0] ??
    ASPECTO_INICIAL.tituloPeso;
  const tituloMayusculas =
    typeof data.tituloMayusculas === 'boolean'
      ? data.tituloMayusculas
      : ASPECTO_INICIAL.tituloMayusculas;
  const tituloColor = colorValido(data.tituloColor);
  const acento = colorValido(data.acento);
  const mostrarDominio =
    typeof data.mostrarDominio === 'boolean'
      ? data.mostrarDominio
      : ASPECTO_INICIAL.mostrarDominio;

  return {
    fondo,
    color,
    intensidad,
    tema,
    fuente,
    densidad,
    texto,
    tituloTamano,
    tituloPeso,
    tituloMayusculas,
    tituloColor,
    acento,
    mostrarDominio,
  };
}

/** `#3fe0c5` → `63, 224, 197`, para usarlo dentro de `rgba()` en CSS. */
export function rgbDe(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function aspectoCss(a: Aspecto): {
  atributos: Record<string, string>;
  variables: Record<string, string | null>;
} {
  return {
    atributos: {
      'data-tema': a.tema,
      'data-fuente': a.fuente,
      'data-densidad': a.densidad,
      'data-mayus': a.tituloMayusculas ? 'si' : 'no',
      'data-dominio': a.mostrarDominio ? 'si' : 'no',
    },
    variables: {
      '--escala': String(a.texto / 100),
      '--titulo-escala': String(a.tituloTamano / 100),
      '--titulo-peso': String(a.tituloPeso),
      '--titulo-color': a.tituloColor,
      '--acento-usuario': a.acento,
    },
  };
}