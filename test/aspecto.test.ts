import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAspecto,
  rgbDe,
  ASPECTO_INICIAL,
  aspectoCss,
  TEMAS,
  FUENTES,
  DENSIDADES,
  PESOS_TITULO,
} from '../src/shared/aspecto.ts';

test('sin datos o con datos rotos devuelve el aspecto inicial', () => {
  assert.deepEqual(parseAspecto(null), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto(''), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto('no es json'), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto('[1,2]'), ASPECTO_INICIAL);
  assert.deepEqual(parseAspecto('42'), ASPECTO_INICIAL);
});

test('acepta valores válidos y normaliza el color', () => {
  const a = parseAspecto(JSON.stringify({ fondo: 'aurora', color: '#FF8800', intensidad: 80 }));
  assert.deepEqual(a, {
    fondo: 'aurora',
    color: '#ff8800',
    intensidad: 80,
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
  });
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

test('defaults completos del aspecto inicial', () => {
  assert.deepEqual(ASPECTO_INICIAL, {
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
  });
});

test('formato antiguo {fondo,color,intensidad} se completa', () => {
  const a = parseAspecto(JSON.stringify({ fondo: 'aurora', color: '#FF8800', intensidad: 80 }));
  assert.deepEqual(a, {
    fondo: 'aurora',
    color: '#ff8800',
    intensidad: 80,
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
  });
});

test('campos nuevos válidos', () => {
  const a = parseAspecto(
    JSON.stringify({
      tema: 'contraste',
      fuente: 'serif',
      densidad: 'comoda',
      texto: 130,
      tituloTamano: 150,
      tituloPeso: 800,
      tituloMayusculas: false,
      tituloColor: '#ABCDEF',
      acento: '#123456',
      mostrarDominio: false,
    }),
  );
  assert.equal(a.tema, 'contraste');
  assert.equal(a.fuente, 'serif');
  assert.equal(a.densidad, 'comoda');
  assert.equal(a.texto, 130);
  assert.equal(a.tituloTamano, 150);
  assert.equal(a.tituloPeso, 800);
  assert.equal(a.tituloMayusculas, false);
  assert.equal(a.tituloColor, '#abcdef');
  assert.equal(a.acento, '#123456');
  assert.equal(a.mostrarDominio, false);
});

test('campos nuevos inválidos vuelven al inicial', () => {
  const a = parseAspecto(
    JSON.stringify({
      tema: 'oscuro',
      fuente: 'mono',
      densidad: 'normal',
      texto: 100,
      tituloTamano: 120,
      tituloPeso: 700,
      tituloMayusculas: true,
      tituloColor: '#rrggbb',
      acento: 'red;background:url(//x)',
      mostrarDominio: true,
    }),
  );
  // acento inválido -> null
  assert.equal(a.acento, null);
  // otros válidos se mantienen
  assert.equal(a.tituloColor, null);
});

test('tipos erróneos de los campos nuevos vuelven al inicial', () => {
  const a = parseAspecto(
    JSON.stringify({
      tema: 1,
      fuente: [],
      densidad: {},
      texto: 'x',
      tituloTamano: null,
      tituloPeso: '700',
      tituloMayusculas: 1,
      tituloColor: 42,
      acento: {},
      mostrarDominio: 'si',
    }),
  );
  assert.deepEqual(a, ASPECTO_INICIAL);
});

test('acotado y redondeo de números', () => {
  assert.equal(parseAspecto('{"texto":79}').texto, 80);
  assert.equal(parseAspecto('{"texto":201}').texto, 200);
  assert.equal(parseAspecto('{"texto":"x"}').texto, 100);
  assert.equal(parseAspecto('{"texto":100.4}').texto, 100);
  assert.equal(parseAspecto('{"tituloTamano":99}').tituloTamano, 100);
  assert.equal(parseAspecto('{"tituloTamano":300}').tituloTamano, 220);
  assert.equal(parseAspecto('{"tituloTamano":120.6}').tituloTamano, 121);
});

test('tituloPeso solo acepta valores de la lista', () => {
  assert.equal(parseAspecto('{"tituloPeso":500}').tituloPeso, 700);
  assert.equal(parseAspecto('{"tituloPeso":400}').tituloPeso, 400);
  assert.equal(parseAspecto('{"tituloPeso":600}').tituloPeso, 600);
  assert.equal(parseAspecto('{"tituloPeso":800}').tituloPeso, 800);
});

test('intento de inyección CSS en colores devuelve null', () => {
  assert.equal(parseAspecto(JSON.stringify({ tituloColor: 'red;background:url(//x)' })).tituloColor, null);
  assert.equal(parseAspecto(JSON.stringify({ tituloColor: '#fff;x' })).tituloColor, null);
  assert.equal(parseAspecto(JSON.stringify({ acento: 'red;background:url(//x)' })).acento, null);
  assert.equal(parseAspecto(JSON.stringify({ acento: '#fff;x' })).acento, null);
  assert.equal(parseAspecto(JSON.stringify({ color: 'red;background:url(//x)' })).color, ASPECTO_INICIAL.color);
});

test('cadenas largas en colores no se aceptan', () => {
  const largo = 'a'.repeat(1000);
  assert.equal(parseAspecto(JSON.stringify({ tituloColor: largo })).tituloColor, null);
  assert.equal(parseAspecto(JSON.stringify({ acento: largo })).acento, null);
  assert.equal(parseAspecto(JSON.stringify({ tema: largo })).tema, ASPECTO_INICIAL.tema);
});

test('aspectoCss con defaults', () => {
  const r = aspectoCss(ASPECTO_INICIAL);
  assert.deepEqual(r.atributos, {
    'data-tema': 'oscuro',
    'data-fuente': 'sistema',
    'data-densidad': 'normal',
    'data-mayus': 'si',
    'data-dominio': 'si',
  });
  assert.deepEqual(r.variables, {
    '--escala': '1',
    '--titulo-escala': '1.2',
    '--titulo-peso': '700',
    '--titulo-color': null,
    '--acento-usuario': null,
  });
});

test('aspectoCss personalizado', () => {
  const a = parseAspecto(
    JSON.stringify({
      texto: 150,
      tituloColor: '#ABCDEF',
      acento: '#123456',
      tituloMayusculas: false,
      mostrarDominio: false,
    }),
  );
  const r = aspectoCss(a);
  assert.deepEqual(r.atributos, {
    'data-tema': 'oscuro',
    'data-fuente': 'sistema',
    'data-densidad': 'normal',
    'data-mayus': 'no',
    'data-dominio': 'no',
  });
  assert.deepEqual(r.variables, {
    '--escala': '1.5',
    '--titulo-escala': '1.2',
    '--titulo-peso': '700',
    '--titulo-color': '#abcdef',
    '--acento-usuario': '#123456',
  });
});

test('null en variable produce null', () => {
  const r = aspectoCss(ASPECTO_INICIAL);
  assert.equal(r.variables['--titulo-color'], null);
  assert.equal(r.variables['--acento-usuario'], null);
});
test('los colores solo admiten #rrggbb exacto: nada antes ni después', () => {
  const malos = ['#ff8800;background:url(//x)', 'x#ff8800', ' #ff8800', '#ff8800 ', '#ff88000', '#ff880', '#gg8800', 'ff8800', '#ff8800\n', 'url(#ff8800)', '#ff8800)}'];
  for (const malo of malos) {
    const a = parseAspecto(JSON.stringify({ color: malo, tituloColor: malo, acento: malo }));
    assert.equal(a.color, ASPECTO_INICIAL.color, JSON.stringify(malo));
    assert.equal(a.tituloColor, null, JSON.stringify(malo));
    assert.equal(a.acento, null, JSON.stringify(malo));
  }
  const bueno = parseAspecto(JSON.stringify({ color: '#AABBCC', tituloColor: '#112233', acento: '#FFEE00' }));
  assert.deepEqual([bueno.color, bueno.tituloColor, bueno.acento], ['#aabbcc', '#112233', '#ffee00']);
});
