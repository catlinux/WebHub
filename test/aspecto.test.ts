import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAspecto, rgbDe, ASPECTO_INICIAL } from '../src/shared/aspecto.ts';

test('sin datos o con datos rotos devuelve el aspecto inicial', () => {
  assert.deepEqual(parseAspecto(null), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto(''), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto('no es json'), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto('[1,2]'), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto('42'), ASPECTO_INICIAL);
});

test('acepta valores válidos y normaliza el color', () => {
  const a = parseAspecto(JSON.stringify({ fondo: 'aurora', color: '#FF8800', intensidad: 80 }));
  assert.deepEqual(a, { fondo: 'aurora', color: '#ff8800', intensidad: 80 });
});

test('descarta lo inválido campo a campo y limita la intensidad', () => {
  const a = parseAspecto(JSON.stringify({ fondo: 'url(x)', color: 'red; background:url(//x)', intensidad: 900 }));
  assert.equal(a.fondo, ASPECTO_INICIAL.fondo);
  assert.equal(a.color, ASPECTO_INICIAL.color);
  assert.equal(a.intensidad, 100);
  assert.equal(parseAspecto('{"intensidad":-5}').intensidad, 0);
  assert.equal(parseAspecto('{"intensidad":"7"}').intensidad, ASPECTO_INICIAL.intensidad);
  assert.equal(parseAspecto('{"intensidad":33.6}').intensidad, 34);
});

test('rgbDe convierte hexadecimal a componentes', () => {
  assert.equal(rgbDe('#3fe0c5'), '63, 224, 197');
  assert.equal(rgbDe('#000000'), '0, 0, 0');
  assert.equal(rgbDe('#ffffff'), '255, 255, 255');
});
