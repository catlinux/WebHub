import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numeroDeColumnas, asignarColumnas, moverGrupo } from '../src/shared/layout.ts';

test('numeroDeColumnas valores típicos', () => {
  assert.equal(numeroDeColumnas(1400, 330, 25), 4);
  assert.equal(numeroDeColumnas(330, 330, 25), 1);
  for (const v of [0, -5, NaN, Infinity]) assert.equal(numeroDeColumnas(v, 330, 25), 1);
});

test('numeroDeColumnas max respetado', () => {
  assert.equal(numeroDeColumnas(10000, 100, 10, 3), 3);
  assert.equal(numeroDeColumnas(100, 100, 10, 12), 1);
});

test('numeroDeColumnas minimo+hueco <= 0 → 1', () => {
  assert.equal(numeroDeColumnas(1000, 0, 0), 1);
  assert.equal(numeroDeColumnas(1000, -5, 10), 1);
  assert.equal(numeroDeColumnas(1000, 10, -20), 1);
});

test('numeroDeColumnas entradas no finitas o negativas → 1', () => {
  assert.equal(numeroDeColumnas(1000, NaN, 10), 1);
  assert.equal(numeroDeColumnas(1000, 100, Infinity), 1);
  assert.equal(numeroDeColumnas(NaN, 100, 10), 1);
  assert.equal(numeroDeColumnas(1000, -1, 10), 1);
  assert.equal(numeroDeColumnas(1000, 100, -1), 1);
});

test('numeroDeColumnas umbral exacto', () => {
  assert.equal(numeroDeColumnas(209, 100, 10), 1);
  assert.equal(numeroDeColumnas(210, 100, 10), 2);
});

test('asignarColumnas explícitas con módulo y n=1', () => {
  assert.equal(asignarColumnas([{ id: 1, col: 5, peso: 1 }], 4).get(1), 1);
  const r1 = asignarColumnas([{ id: 1, col: 2, peso: 1 }, { id: 2, col: null, peso: 1 }], 1);
  assert.equal(r1.get(1), 0);
  assert.equal(r1.get(2), 0);
});

test('asignarColumnas col negativa o no entera se trata como nula', () => {
  const r = asignarColumnas([
    { id: 1, col: -2, peso: 1 },
    { id: 2, col: 1.5, peso: 1 },
  ], 2);
  // auto-reparto con empates: id1 col0, id2 col1
  assert.equal(r.get(1), 0);
  assert.equal(r.get(2), 1);
});

test('asignarColumnas auto-reparto por peso con empates a la columna menor', () => {
  const r = asignarColumnas([
    { id: 1, col: null, peso: 3 },
    { id: 2, col: null, peso: 1 },
    { id: 3, col: null, peso: 1 },
  ], 2);
  assert.equal(r.get(1), 0);
  assert.equal(r.get(2), 1);
  assert.equal(r.get(3), 1);
});

test('asignarColumnas el peso de las explícitas cuenta para las automáticas', () => {
  const r = asignarColumnas([
    { id: 1, col: 0, peso: 5 },
    { id: 2, col: null, peso: 1 },
  ], 2);
  assert.equal(r.get(1), 0);
  assert.equal(r.get(2), 1);
});

test('asignarColumnas orden recibido respetado (auto tras explícitas)', () => {
  const r = asignarColumnas([
    { id: 1, col: null, peso: 1 },
    { id: 2, col: 0, peso: 10 },
  ], 2);
  // explícita cuenta para col0, así que el automático va a col1
  assert.equal(r.get(1), 1);
  assert.equal(r.get(2), 0);
});

test('asignarColumnas pesos inválidos cuentan 0', () => {
  const r = asignarColumnas([
    { id: 1, col: null, peso: NaN },
    { id: 2, col: null, peso: -3 },
    { id: 3, col: null, peso: Infinity },
  ], 2);
  // todos peso 0 (inválido) → empates a la columna menor: todas a col0
  assert.equal(r.get(1), 0);
  assert.equal(r.get(2), 0);
  assert.equal(r.get(3), 0);
});

test('asignarColumnas n inválido se trunca / usa 1', () => {
  assert.equal(asignarColumnas([{ id: 1, col: null, peso: 1 }], 0).size, 1);
  assert.equal(asignarColumnas([{ id: 1, col: null, peso: 1 }], 0).get(1), 0);
  assert.equal(asignarColumnas([{ id: 1, col: null, peso: 1 }], -1).get(1), 0);
  assert.equal(asignarColumnas([{ id: 1, col: null, peso: 1 }], NaN).get(1), 0);
  const r = asignarColumnas([
    { id: 1, col: null, peso: 1 },
    { id: 2, col: null, peso: 1 },
  ], 2.9);
  // n=2 → auto-reparto
  assert.deepEqual(new Set(r.values()), new Set([0, 1]));
});

test('asignarColumnas todas las familias asignadas exactamente una vez', () => {
  const grupos = [
    { id: 1, col: 3, peso: 2 },
    { id: 2, col: null, peso: 1 },
    { id: 3, col: null, peso: 4 },
    { id: 4, col: 7, peso: 0 },
  ];
  const r = asignarColumnas(grupos, 4);
  assert.equal(r.size, grupos.length);
  for (const g of grupos) assert.ok(r.has(g.id));
  const vals = [...r.values()];
  assert.equal(new Set(vals).size <= 4, true);
});

// moverGrupo helpers
function baseMaps() {
  const guardadas = new Map<number, number | null>([
    [1, 0],
    [2, 2],
    [3, null],
    [4, null],
  ]);
  const efectivas = new Map<number, number>([
    [1, 0],
    [2, 2],
    [3, 1],
    [4, 1],
  ]);
  return { guardadas, efectivas };
}

test('moverGrupo mover antes de un grupo de otra columna (cambia columna y orden)', () => {
  const { guardadas, efectivas } = baseMaps();
  const r = moverGrupo([1, 2, 3, 4], guardadas, efectivas, 1, { tipo: 'antes', id: 3 });
  assert.deepEqual(r.items.map((x) => x.id), [2, 1, 3, 4]);
  assert.deepEqual(r.items.map((x) => x.col), [2, 1, 1, 1]);
});

test('moverGrupo mover despues de un grupo', () => {
  const { guardadas, efectivas } = baseMaps();
  const r = moverGrupo([1, 2, 3, 4], guardadas, efectivas, 4, { tipo: 'despues', id: 1 });
  assert.deepEqual(r.items.map((x) => x.id), [1, 4, 2, 3]);
  // 4 new col = efectiva of 1 =0; rest: 2 saved2,3 null→1,1 saved0
  assert.deepEqual(r.items.map((x) => x.col), [0, 0, 2, 1]);
});

test('moverGrupo mover dentro de la misma columna', () => {
  const guardadas = new Map<number, number | null>([[1, 0], [2, 0], [3, null]]);
  const efectivas = new Map<number, number>([[1, 0], [2, 0], [3, 0]]);
  const r = moverGrupo([1, 2, 3], guardadas, efectivas, 3, { tipo: 'antes', id: 1 });
  assert.deepEqual(r.items.map((x) => x.id), [3, 1, 2]);
  assert.deepEqual(r.items.map((x) => x.col), [0, 0, 0]);
});

test('moverGrupo final en columna vacía al final del orden global', () => {
  const { guardadas, efectivas } = baseMaps();
  const r = moverGrupo([1, 2, 3, 4], guardadas, efectivas, 2, { tipo: 'final', col: 5 });
  assert.deepEqual(r.items.map((x) => x.id), [1, 3, 4, 2]);
  assert.equal(r.items.find((x) => x.id === 2)!.col, 5);
  // resto conservan guardadas o efectivas
  assert.equal(r.items.find((x) => x.id === 1)!.col, 0);
  assert.equal(r.items.find((x) => x.id === 3)!.col, 1);
  assert.equal(r.items.find((x) => x.id === 4)!.col, 1);
});

test('moverGrupo final en columna con grupos justo despues del ultimo de esa columna', () => {
  const guardadas = new Map<number, number | null>([[1, null], [2, null], [3, null], [4, null]]);
  const efectivas = new Map<number, number>([[1, 0], [2, 1], [3, 0], [4, 2]]);
  const r = moverGrupo([1, 2, 3, 4], guardadas, efectivas, 2, { tipo: 'final', col: 0 });
  assert.deepEqual(r.items.map((x) => x.id), [1, 3, 2, 4]);
  assert.equal(r.items.find((x) => x.id === 2)!.col, 0);
});

test('moverGrupo conserva columna guardada incluso si efectiva distinta', () => {
  const guardadas = new Map<number, number | null>([[1, 7], [2, null]]);
  const efectivas = new Map<number, number>([[1, 1], [2, 1]]);
  const r = moverGrupo([1, 2], guardadas, efectivas, 2, { tipo: 'antes', id: 1 });
  assert.equal(r.items.find((x) => x.id === 1)!.col, 7);
});

test('moverGrupo fija los grupos nulos a su columna efectiva', () => {
  const guardadas = new Map<number, number | null>([[1, null], [2, null]]);
  const efectivas = new Map<number, number>([[1, 3], [2, 4]]);
  const r = moverGrupo([1, 2], guardadas, efectivas, 1, { tipo: 'despues', id: 2 });
  assert.equal(r.items.find((x) => x.id === 2)!.col, 4);
  // id1 dragged → col efectiva of 2 =4; id2 rest null→4
  assert.equal(r.items.find((x) => x.id === 1)!.col, 4);
});

test('moverGrupo todos los ids exactamente una vez', () => {
  const { guardadas, efectivas } = baseMaps();
  const r = moverGrupo([1, 2, 3, 4], guardadas, efectivas, 2, { tipo: 'final', col: 1 });
  const ids = r.items.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [1, 2, 3, 4]);
});

test('moverGrupo no muta las entradas', () => {
  const { guardadas, efectivas } = baseMaps();
  const orden = [1, 2, 3, 4];
  const ordenCopia = [...orden];
  const guardadasCopia = new Map(guardadas);
  const efectivasCopia = new Map(efectivas);
  moverGrupo(orden, guardadas, efectivas, 1, { tipo: 'antes', id: 3 });
  assert.deepEqual(orden, ordenCopia);
  assert.deepEqual([...guardadas.entries()], [...guardadasCopia.entries()]);
  assert.deepEqual([...efectivas.entries()], [...efectivasCopia.entries()]);
});

test('moverGrupo casos inválidos devuelven el diseño sin cambios', () => {
  const { guardadas, efectivas } = baseMaps();
  const orden = [1, 2, 3, 4];
  // arrastrado ausente
  let r = moverGrupo(orden, guardadas, efectivas, 99, { tipo: 'antes', id: 2 });
  assert.deepEqual(r.items.map((x) => x.id), orden);
  // destino propio
  r = moverGrupo(orden, guardadas, efectivas, 1, { tipo: 'despues', id: 1 });
  assert.deepEqual(r.items.map((x) => x.id), orden);
  // destino inexistente
  r = moverGrupo(orden, guardadas, efectivas, 1, { tipo: 'antes', id: 999 });
  assert.deepEqual(r.items.map((x) => x.id), orden);
  // col negativa / no entera
  r = moverGrupo(orden, guardadas, efectivas, 1, { tipo: 'final', col: -1 });
  assert.deepEqual(r.items.map((x) => x.id), orden);
  r = moverGrupo(orden, guardadas, efectivas, 1, { tipo: 'final', col: 2.5 });
  assert.deepEqual(r.items.map((x) => x.id), orden);
});

test('moverGrupo mover a su sitio produce el mismo orden', () => {
  const { guardadas, efectivas } = baseMaps();
  const r = moverGrupo([1, 2, 3, 4], guardadas, efectivas, 2, { tipo: 'antes', id: 3 });
  assert.deepEqual(r.items.map((x) => x.id), [1, 2, 3, 4]);
});
test('invalido no cambia columnas normalizadas', () => {
  const guardadas = new Map<number, number | null>([[1, null], [2, 2]]);
  const efectivas = new Map<number, number>([[1, 1], [2, 2]]);
  const r = moverGrupo([1, 2], guardadas, efectivas, 99, { tipo: 'final', col: 0 });
  assert.deepEqual(r.items, [{ id: 1, col: 1 }, { id: 2, col: 2 }]);
});
test('moverGrupo: soltar un grupo sobre sí mismo (antes o después) no cambia nada', () => {
  const guardadas = new Map<number, number | null>([[1, 0], [2, 1], [3, 0]]);
  const efectivas = new Map<number, number>([[1, 0], [2, 1], [3, 0]]);
  const esperado = [{ id: 1, col: 0 }, { id: 2, col: 1 }, { id: 3, col: 0 }];
  for (const tipo of ['antes', 'despues'] as const) {
    for (const arrastrado of [1, 2, 3]) {
      const r = moverGrupo([1, 2, 3], guardadas, efectivas, arrastrado, { tipo, id: arrastrado });
      assert.deepEqual(r.items, esperado, `${tipo} ${arrastrado}`);
    }
  }
});

test('asignarColumnas: n no entero se trunca (2.9 → 2 columnas, nunca la 2)', () => {
  const grupos = [1, 2, 3, 4, 5].map((id) => ({ id, col: null, peso: 1 }));
  const r = asignarColumnas(grupos, 2.9);
  assert.ok([...r.values()].every((c) => c === 0 || c === 1), JSON.stringify([...r]));
  const r2 = asignarColumnas([{ id: 1, col: 5, peso: 1 }], 2.9);
  assert.equal(r2.get(1), 1);
});
