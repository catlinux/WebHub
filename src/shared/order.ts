/** Devuelve una copia de la lista con el elemento de `from` movido a `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(to, out.length - 1));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

/**
 * Comprueba que `ids` es una permutación exacta de `current`
 * (mismos elementos, sin repetidos ni ajenos). Se usa para validar las
 * peticiones de reordenación antes de escribir posiciones.
 */
export function isPermutation(current: readonly number[], ids: readonly number[]): boolean {
  if (current.length !== ids.length) return false;
  const set = new Set(current);
  const seen = new Set<number>();
  for (const id of ids) {
    if (!set.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/** Ordena por posición y, a igualdad, por id (orden estable y predecible). */
export function byPosition<T extends { position: number; id: number }>(a: T, b: T): number {
  return a.position - b.position || a.id - b.id;
}
