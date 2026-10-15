/** Lógica pura del reparto de grupos (familias principales con sus subfamilias) en columnas explícitas. */

export interface GrupoColumna {
  id: number;
  col: number | null;
  peso: number;
}

export type Destino =
  | { tipo: 'antes' | 'despues'; id: number }
  | { tipo: 'final'; col: number };

function aEnteroValido(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export function numeroDeColumnas(ancho: number, minimo: number, hueco: number, max: number = 12): number {
  if (!Number.isFinite(ancho) || !Number.isFinite(minimo) || !Number.isFinite(hueco) || !Number.isFinite(max)) return 1;
  if (ancho < 0 || minimo < 0 || hueco < 0 || max < 1) return 1;
  if (minimo + hueco <= 0) return 1;
  const raw = Math.floor((ancho + hueco) / (minimo + hueco));
  return Math.max(1, Math.min(raw, max));
}

export function asignarColumnas(
  grupos: { id: number; col: number | null; peso: number }[],
  n: number,
): Map<number, number> {
  let columnas = Number.isFinite(n) ? Math.trunc(n) : 1;
  if (columnas < 1) columnas = 1;

  const acumulado: number[] = new Array(columnas).fill(0);
  const resultado = new Map<number, number>();

  // Grupos con columna explícita primero.
  const automaticos: { id: number; col: number | null; peso: number }[] = [];
  for (const g of grupos) {
    const col = g.col;
    const peso = Number.isFinite(g.peso) && (g.peso as number) >= 0 ? (g.peso as number) : 0;
    if (typeof col === 'number' && Number.isInteger(col) && col >= 0) {
      const c = col % columnas;
      resultado.set(g.id, c);
      acumulado[c] += peso;
    } else {
      automaticos.push({ id: g.id, col: null, peso });
    }
  }

  // Grupos automáticos, en el orden recibido, columnas de menor peso acumulado.
  for (const g of automaticos) {
    const peso = Number.isFinite(g.peso) && (g.peso as number) >= 0 ? (g.peso as number) : 0;
    let indiceMin = 0;
    let valorMin = acumulado[0];
    for (let i = 1; i < columnas; i++) {
      if (acumulado[i] < valorMin) {
        valorMin = acumulado[i];
        indiceMin = i;
      }
    }
    resultado.set(g.id, indiceMin);
    acumulado[indiceMin] += peso;
  }

  return resultado;
}

export function moverGrupo(
  orden: readonly number[],
  guardadas: ReadonlyMap<number, number | null>,
  efectivas: ReadonlyMap<number, number>,
  arrastrado: number,
  destino: Destino,
): { items: { id: number; col: number }[] } {
  const ordenActual = [...orden];

  const columnaNormalizada = (id: number): number => {
    const guardada = guardadas.get(id);
    if (guardada === null || guardada === undefined) {
      return (efectivas.get(id) as number) ?? 0;
    }
    return guardada;
  };

  // Validación.
  let invalido = false;
  if (destino.tipo === 'antes' || destino.tipo === 'despues') {
    if (!ordenActual.includes(arrastrado)) invalido = true;
    else if (destino.id === arrastrado) invalido = true;
    else if (!ordenActual.includes(destino.id)) invalido = true;
  } else if (destino.tipo === 'final') {
    if (!ordenActual.includes(arrastrado)) invalido = true;
    else if (!aEnteroValido(destino.col) || (destino.col as number) < 0) invalido = true;
  } else {
    invalido = true;
  }

  if (invalido) {
    return { items: ordenActual.map((id) => ({ id, col: columnaNormalizada(id) })) };
  }

  // Nuevo orden: quitar el arrastrado e insertar.
  const base = ordenActual.filter((id) => id !== arrastrado);
  let insertarEn = 0;
  let columnaArrastrado = 0;

  if (destino.tipo === 'antes' || destino.tipo === 'despues') {
    const idx = base.indexOf(destino.id);
    insertarEn = destino.tipo === 'antes' ? idx : idx + 1;
    columnaArrastrado = (efectivas.get(destino.id) as number) ?? 0;
  } else if (destino.tipo === 'final') {
    const col = destino.col;
    columnaArrastrado = col;
    let ultimo = -1;
    for (let i = base.length - 1; i >= 0; i--) {
      if (efectivas.get(base[i]) === col) {
        ultimo = i;
        break;
      }
    }
    insertarEn = ultimo === -1 ? base.length : ultimo + 1;
  }

  base.splice(insertarEn, 0, arrastrado);

  return {
    items: base.map((id) => ({
      id,
      col: id === arrastrado ? columnaArrastrado : columnaNormalizada(id),
    })),
  };
}