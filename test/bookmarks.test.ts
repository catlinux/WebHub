import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeEntities, parseBookmarksHtml, planImport } from '../src/shared/bookmarks.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const noExisting = { existingUrls: [], existingFamilies: [], unwrapContainers: true };

test('decodifica entidades HTML', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#233; &#xE9; &quot;'), 'a & b <c> é é "');
  assert.equal(decodeEntities('&desconocida;'), '&desconocida;');
});

test('lee el árbol de carpetas de Chrome', () => {
  const root = parseBookmarksHtml(fixture('chrome.html'));
  assert.equal(root.folders.length, 2);
  const bar = root.folders[0]!;
  assert.equal(bar.name, 'Barra de marcadores');
  assert.equal(bar.toolbar, true);
  assert.equal(bar.links[0]!.title, 'Google');
  const prov = bar.folders[0]!;
  assert.equal(prov.name, 'Proveedores');
  assert.equal(prov.links[0]!.title, 'OVHcloud & servidores');
  assert.equal(prov.folders[0]!.folders[0]!.links[0]!.href, 'https://www.godaddy.com/');
});

test('lee notas <DD> de Firefox y no confunde la descripción de carpeta', () => {
  const root = parseBookmarksHtml(fixture('firefox.html'));
  assert.equal(root.links.length, 2);
  const toolbar = root.folders[0]!;
  assert.equal(toolbar.toolbar, true);
  const interes = toolbar.folders[0]!;
  assert.equal(interes.links[0]!.note, 'Noticias del kernel <semanal>');
  assert.equal(interes.links[1]!.note, '');
});

test('el plan conserva carpetas como familias y aplana niveles profundos', () => {
  const plan = planImport(parseBookmarksHtml(fixture('chrome.html')), noExisting);
  const names = plan.groups.map((g) => `${g.parentKey ?? '-'}|${g.name}`);
  assert.deepEqual(names, [
    '-|Barra de marcadores',
    '-|Proveedores',
    'proveedores|Dominios',
    'proveedores|Dominios / Antiguos',
    '-|Redes',
    '-|Otros marcadores',
  ]);
  assert.ok(!plan.groups.some((g) => g.name === 'Vacía'));
});

test('el plan descarta esquemas no http(s) y marca duplicados', () => {
  const plan = planImport(parseBookmarksHtml(fixture('chrome.html')), {
    ...noExisting,
    existingUrls: ['https://dash.cloudflare.com'],
  });
  assert.equal(plan.invalid, 1);
  const all = plan.groups.flatMap((g) => g.links);
  assert.ok(!all.some((l) => l.url.startsWith('javascript')));
  assert.equal(all.find((l) => l.title === 'Cloudflare')!.duplicate, 'existing');
  assert.equal(all.find((l) => l.title === 'Google otra vez')!.duplicate, 'inFile');
  assert.equal(all.find((l) => l.title === 'Google')!.duplicate, null);
  assert.equal(plan.duplicates, 2);
  assert.equal(plan.totalLinks, 8);
});

test('sin desenvolver contenedores, la barra es una familia más', () => {
  const plan = planImport(parseBookmarksHtml(fixture('chrome.html')), { ...noExisting, unwrapContainers: false });
  assert.equal(plan.groups.filter((g) => g.parentKey === null).map((g) => g.name).join(','), 'Barra de marcadores,Otros marcadores');
  assert.ok(plan.groups.some((g) => g.name === 'Proveedores / Dominios / Antiguos'));
});

test('los enlaces sueltos de la raíz van a «Importados» y se reutilizan familias existentes', () => {
  const plan = planImport(parseBookmarksHtml(fixture('firefox.html')), {
    ...noExisting,
    existingFamilies: [{ id: 7, name: 'interés', parentId: null }],
  });
  const loose = plan.groups.find((g) => g.name === 'Importados')!;
  assert.equal(loose.links.length, 1);
  assert.equal(plan.invalid, 1);
  assert.equal(plan.groups.find((g) => g.name === 'Interés')!.existingFamilyId, 7);
});
