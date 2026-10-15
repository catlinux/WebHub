import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodificarHtml,
  extraerMeta,
  normalizarEtiqueta,
  claveEtiqueta,
  proponerEtiquetas
} from '../src/server/analizador.ts';

// ---------- decodificarHtml ----------

test('decodificarHtml utf-8 desde cabecera', () => {
  const b = Buffer.from('café — naïve', 'utf8');
  assert.equal(decodificarHtml(b, 'text/html; charset=utf-8'), 'café — naïve');
});

test('decodificarHtml iso-8859-1 anunciado en cabecera', () => {
  const b = Buffer.from('cañé', 'latin1');
  assert.equal(decodificarHtml(b, 'text/html; charset=iso-8859-1'), 'cañé');
});

test('decodificarHtml meta charset real', () => {
  const html = '<meta charset="iso-8859-1"><p>niño café</p>';
  const b = Buffer.from(html, 'latin1');
  assert.equal(decodificarHtml(b, 'text/html'), html);
});

test('decodificarHtml meta http-equiv', () => {
  const html = '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>niño café</p>';
  const b = Buffer.from(html, 'latin1');
  assert.equal(decodificarHtml(b, 'text/html'), html);
});

test('decodificarHtml charset desconocido cae a utf-8 sin lanzar', () => {
  const b = Buffer.from('hola', 'utf8');
  assert.doesNotThrow(() => decodificarHtml(b, 'text/html; charset=marciano'));
  const out = decodificarHtml(b, 'text/html; charset=marciano');
  assert.equal(out, 'hola');
});

test('decodificarHtml iso-8859-15 y windows-1252', () => {
  const b15 = Buffer.from('a', 'latin1');
  // solo verificar que no lanzan
  assert.doesNotThrow(() => decodificarHtml(b15, 'text/html; charset=iso-8859-15'));
  const b1252 = Buffer.from('\x80', 'binary');
  assert.doesNotThrow(() => decodificarHtml(b1252, 'text/html; charset=windows-1252'));
});

// ---------- extraerMeta ----------

test('extraerMeta título con entidades', () => {
  const html = `<head><title>&amp; &quot; &#39; &#233; &#xE9; &eacute; &ntilde; &nbsp;end</title></head>`;
  const m = extraerMeta(html);
  // &nbsp; colapsa a espacio
  assert.match(m.titulo, /^& " ' é é é ñ end$/);
});

test('extraerMeta título colapsa espacios y saltos', () => {
  const html = `<head><title>  hola   mundo\n\n  x  </title></head>`;
  assert.equal(extraerMeta(html).titulo, 'hola mundo x');
});

test('extraerMeta título 400 a 300', () => {
  const t = 'a'.repeat(400);
  const html = `<head><title>${t}</title></head>`;
  assert.equal(extraerMeta(html).titulo.length, 300);
});

test('extraerMeta descripción 600 a 500', () => {
  const d = 'b'.repeat(600);
  const html = `<head><meta name="description" content="${d}"></head>`;
  assert.equal(extraerMeta(html).descripcion.length, 500);
});

test('extraerMeta atributos en orden inverso', () => {
  const html = `<head><meta content="desc inv" name="description"></head>`;
  assert.equal(extraerMeta(html).descripcion, 'desc inv');
});

test('extraerMeta comillas simples', () => {
  const html = `<head><meta name='description' content='simple'></head>`;
  assert.equal(extraerMeta(html).descripcion, 'simple');
});

test('extraerMeta sin comillas', () => {
  const html = `<head><meta name=description content=sincomillas></head>`;
  assert.equal(extraerMeta(html).descripcion, 'sincomillas');
});

test('extraerMeta etiquetas mayúsculas', () => {
  const html = `<HEAD><TITLE>T</TITLE><META NAME="DESCRIPTION" CONTENT="D"></HEAD>`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'T');
  assert.equal(m.descripcion, 'D');
});

test('extraerMeta og fallback usado', () => {
  const html = `<head><meta property="og:title" content="OGT"><meta property="og:description" content="OGD"></head>`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'OGT');
  assert.equal(m.descripcion, 'OGD');
});

test('extraerMeta title/description prevalecen sobre og', () => {
  const html = `<head><title>T1</title><meta name="description" content="D1"><meta property="og:title" content="OGT"><meta property="og:description" content="OGD"></head>`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'T1');
  assert.equal(m.descripcion, 'D1');
});

test('extraerMeta twitter respaldo', () => {
  const html = `<head><meta name="twitter:title" content="TT"><meta name="twitter:description" content="TD"></head>`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'TT');
  assert.equal(m.descripcion, 'TD');
});

test('extraerMeta keywords coma y puntoycoma con vacíos', () => {
  const html = `<head><meta name="keywords" content="a, ,b;c;; d"></head>`;
  assert.deepEqual(extraerMeta(html).palabrasClave, ['a', 'b', 'c', 'd']);
});

test('extraerMeta keywords más de 20 se recortan', () => {
  const ks = Array.from({ length: 30 }, (_, i) => `k${i}`).join(',');
  const html = `<head><meta name="keywords" content="${ks}"></head>`;
  assert.equal(extraerMeta(html).palabrasClave.length, 20);
});

test('extraerMeta article:tag repetido', () => {
  const html = `<head><meta property="article:tag" content="x"><meta property="article:tag" content="y"></head>`;
  assert.deepEqual(extraerMeta(html).etiquetasArticulo, ['x', 'y']);
});

test('extraerMeta og:type y og:site_name', () => {
  const html = `<head><meta property="og:type" content="Article"><meta property="og:site_name" content="Mi Sitio"></head>`;
  const m = extraerMeta(html);
  assert.equal(m.tipo, 'article');
  assert.equal(m.nombreSitio, 'Mi Sitio');
});

test('extraerMeta idioma html lang', () => {
  const html = `<html lang="es-ES"><head></head></html>`;
  assert.equal(extraerMeta(html).idioma, 'es');
});

test('extraerMeta ignora metadatos falsos en script/style/comentarios/svg', () => {
  const html = `<!doctype html><html><head>
  <!-- <meta name="description" content="falso1"> -->
  <script>var x = '<meta name="description" content="falso2"><title>falso3</title>';</script>
  <style>.x:before{content:"<title>falso4</title>"}</style>
  <svg><title>falso5</title><meta name="description" content="falso6"></svg>
  <title>REAL</title>
  <meta name="description" content="REALD">
  </head>`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'REAL');
  assert.equal(m.descripcion, 'REALD');
});

test('extraerMeta ignora metadatos después de </head>', () => {
  const html = `<head><title>REAL</title></head><body><title>FALSO</title><meta name="description" content="FALSO"></body>`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'REAL');
  assert.equal(m.descripcion, '');
});

test('extraerMeta HTML roto sin cierre', () => {
  const html = `<title>RT</title><meta name="description" content="RD">`;
  const m = extraerMeta(html);
  assert.equal(m.titulo, 'RT');
  assert.equal(m.descripcion, 'RD');
});

test('extraerMeta cadena vacía', () => {
  const m = extraerMeta('');
  assert.deepEqual(m, { titulo: '', descripcion: '', palabrasClave: [], etiquetasArticulo: [], tipo: '', nombreSitio: '', idioma: '' });
});

// ---------- normalizarEtiqueta ----------

test('normalizar #Git', () => assert.equal(normalizarEtiqueta('#Git'), 'git'));
test('normalizar comillas docs', () => assert.equal(normalizarEtiqueta(' "Docs" '), 'docs'));
test('normalizar muy corto', () => assert.equal(normalizarEtiqueta('a'), null));
test('normalizar 31 chars', () => assert.equal(normalizarEtiqueta('a'.repeat(31)), null));
test('normalizar 4 palabras', () => assert.equal(normalizarEtiqueta('uno dos tres cuatro'), null));
test('normalizar node.js válido', () => assert.equal(normalizarEtiqueta('node.js'), 'node.js'));
test('normalizar bases de datos válido', () => assert.equal(normalizarEtiqueta('bases de datos'), 'bases de datos'));
test('normalizar x<y inválido', () => assert.equal(normalizarEtiqueta('x<y'), null));
test('normalizar stopword de', () => assert.equal(normalizarEtiqueta('de'), null));
test('normalizar Año', () => assert.equal(normalizarEtiqueta('Año'), 'año'));

// ---------- claveEtiqueta ----------

test('claveEtiqueta iguala con/sin tilde y mayúsculas', () => {
  assert.equal(claveEtiqueta('Documentación'), claveEtiqueta('documentacion'));
  assert.equal(claveEtiqueta('DOCUMENTACIÓN'), claveEtiqueta('documentación'));
});

// ---------- proponerEtiquetas ----------

test('proponer orden de prioridad y usuario con tilde primero', () => {
  const meta = extraerMeta(`<head><title>t</title><meta name="keywords" content="documentacion"></head>`);
  const out = proponerEtiquetas({ host: 'example.com', meta, usadas: ['Documentación'] });
  assert.ok(out.length > 0);
  assert.equal(out[0], 'Documentación');
});

test('proponer usuario que no aparece no se propone', () => {
  const meta = extraerMeta(`<head><title>hola mundo</title></head>`);
  const out = proponerEtiquetas({ host: 'example.com', meta, usadas: ['zzzinexistente'] });
  assert.ok(!out.includes('zzzinexistente'));
});

test('proponer tope 8', () => {
  const ks = Array.from({ length: 20 }, (_, i) => `k${i}`).join(',');
  const meta = extraerMeta(`<head><title>x</title><meta name="keywords" content="${ks}"></head>`);
  const usadas = Array.from({ length: 5 }, (_, i) => `u${i}`);
  const meta2 = { ...meta, palabrasClave: [...meta.palabrasClave, ...usadas.map(u=>u.toUpperCase())] };
  const out = proponerEtiquetas({ host: 'example.com', meta: meta2, usadas });
  assert.ok(out.length <= 8);
});

test('proponer sin duplicados con/sin tilde', () => {
  const meta = extraerMeta(`<head><title>x</title><meta name="keywords" content="documentacion"></head>`);
  const out = proponerEtiquetas({ host: 'example.com', meta, usadas: ['Documentación'] });
  const keys = out.map(claveEtiqueta);
  assert.equal(new Set(keys).size, keys.length);
});

test('proponer github.com y www.github.com', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  for (const h of ['github.com', 'www.github.com']) {
    const out = proponerEtiquetas({ host: h, meta, usadas: [] });
    assert.deepEqual(out.slice(0,2), ['git','código'], h);
  }
});

test('proponer notgithub.com no activa github', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  for (const h of ['notgithub.com', 'github.com.evil.com']) {
    const out = proponerEtiquetas({ host: h, meta, usadas: [] });
    assert.ok(!out.includes('git'), h);
  }
});

test('proponer youtube.com', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  const out = proponerEtiquetas({ host: 'youtube.com', meta, usadas: [] });
  assert.ok(out.includes('vídeo'));
});

test('proponer docs prefix host y ruta', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  const out1 = proponerEtiquetas({ host: 'docs.ejemplo.com', ruta: '/', meta, usadas: [] });
  assert.ok(out1.includes('documentación'));
  const out2 = proponerEtiquetas({ host: 'ejemplo.com', ruta: '/docs/x', meta, usadas: [] });
  assert.ok(out2.includes('documentación'));
});

test('proponer wiki/panel/status/api/mail prefixes', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  const cases: Array<[string,string]> = [
    ['wiki.x.com','wiki'],
    ['panel.x.com','panel'],
    ['status.x.com','monitor'],
    ['api.x.com','api'],
    ['mail.x.com','correo']
  ];
  for (const [h, tag] of cases) {
    const out = proponerEtiquetas({ host: h, meta, usadas: [] });
    assert.ok(out.includes(tag), h);
  }
});

test('proponer wikipedia subdominio', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  const out = proponerEtiquetas({ host: 'es.wikipedia.org', meta, usadas: [] });
  assert.ok(out.includes('enciclopedia'));
});

test('proponer tipo video/article', () => {
  const mv = extraerMeta(`<head><meta property="og:type" content="video"></head>`);
  const outv = proponerEtiquetas({ host: 'x.com', meta: mv, usadas: [] });
  assert.ok(outv.includes('vídeo'));
  const ma = extraerMeta(`<head><meta property="og:type" content="article"></head>`);
  const outa = proponerEtiquetas({ host: 'x.com', meta: ma, usadas: [] });
  assert.ok(outa.includes('artículo'));
});

test('proponer palabras frecuentes', () => {
  const meta = extraerMeta(`<head><title>node node js</title><meta name="description" content="node js node"></head>`);
  const out = proponerEtiquetas({ host: 'x.com', meta, usadas: [] });
  // 'node' aparece >=2 y 4 letras
  assert.ok(out.includes('node'));
});

test('proponer ignora stopwords y palabras cortas en frecuentes', () => {
  const meta = extraerMeta(`<head><title>de la el los mas the and for</title><meta name="description" content="de la el los mas the and for"></head>`);
  const out = proponerEtiquetas({ host: 'x.com', meta, usadas: [] });
  for (const w of ['de','la','el','los','the','and','for']) assert.ok(!out.includes(w));
});

test('proponer maximo 3 frecuentes', () => {
  const meta = extraerMeta(`<head><title>aaaa bbbb cccc dddd eeee</title><meta name="description" content="aaaa bbbb cccc dddd eeee"></head>`);
  const out = proponerEtiquetas({ host: 'x.com', meta, usadas: [] });
  const freqs = ['aaaa','bbbb','cccc','dddd','eeee'].filter(w=>out.includes(w));
  assert.ok(freqs.length <= 3);
});

test('proponer entradas raras sin excepcion', () => {
  assert.doesNotThrow(() => proponerEtiquetas({ host: '', meta: extraerMeta(''), usadas: ['<script>x</script>', 'a;b', '   '] }));
});

test('proponer descarta keyword peligrosa', () => {
  const meta = extraerMeta(`<head><title>t</title><meta name="keywords" content="<script>alert(1)</script>"></head>`);
  const out = proponerEtiquetas({ host: 'x.com', meta, usadas: [] });
  assert.ok(!out.some(t => t.includes('script')));
});

test('proponer b max 5 entre keyword y article', () => {
  const ks = Array.from({ length: 10 }, (_, i) => `k${i}`).join(',');
  const meta = extraerMeta(`<head><title>t</title><meta name="keywords" content="${ks}"><meta property="article:tag" content="a1"><meta property="article:tag" content="a2"></head>`);
  const out = proponerEtiquetas({ host: 'x.com', meta, usadas: [] });
  // sin reglas de dominio, solo b + frecuentes; b aporta <=5
  const btags = ['k0','k1','k2','k3','k4','k5','k6','k7','k8','k9','a1','a2'].filter(t=>out.includes(t));
  assert.ok(btags.length <= 5);
});

test('proponer stackoverflow.com', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  const out = proponerEtiquetas({ host: 'stackoverflow.com', meta, usadas: [] });
  assert.ok(out.includes('programación'));
});

test('proponer gitlab bitbucket', () => {
  const meta = extraerMeta(`<head><title>x</title></head>`);
  for (const h of ['gitlab.com','bitbucket.org']) {
    const out = proponerEtiquetas({ host: h, meta, usadas: [] });
    assert.ok(out.includes('git') && out.includes('código'), h);
  }
});
import * as An from '../src/server/analizador.ts';

test('extraerMeta: solo lee los primeros 128 KB (un metadato más allá se ignora)', () => {
  const relleno = ' '.repeat(140 * 1024);
  const html = `<html><head><title>Corto</title>${relleno}<meta name="description" content="demasiado tarde"></head></html>`;
  const m = An.extraerMeta(html);
  assert.equal(m.titulo, 'Corto');
  assert.equal(m.descripcion, '');
  const dentro = `<html><head><title>Corto</title>${' '.repeat(100 * 1024)}<meta name="description" content="a tiempo"></head></html>`;
  assert.equal(An.extraerMeta(dentro).descripcion, 'a tiempo');
});

test('extraerMeta: article:tag se recorta a 20 y las palabras clave a 20', () => {
  const tags = Array.from({ length: 30 }, (_, i) => `<meta property="article:tag" content="etiqueta${i}">`).join('');
  const claves = Array.from({ length: 30 }, (_, i) => `clave${i}`).join(',');
  const m = An.extraerMeta(`<head>${tags}<meta name="keywords" content="${claves}"></head>`);
  assert.equal(m.etiquetasArticulo.length, 20);
  assert.equal(m.palabrasClave.length, 20);
});

test('proponerEtiquetas: nunca más de 8 aunque el usuario tenga muchas etiquetas que coinciden', () => {
  const palabras = ['alfa', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'theta', 'iota', 'kappa', 'lambda', 'sigma', 'omega'];
  const meta = An.extraerMeta(`<head><title>${palabras.join(' ')}</title><meta name="keywords" content="${palabras.join(',')}"></head>`);
  const r = An.proponerEtiquetas({ host: 'ejemplo.com', meta, usadas: palabras });
  assert.equal(r.length, 8);
  assert.equal(new Set(r.map(An.claveEtiqueta)).size, 8);
});
