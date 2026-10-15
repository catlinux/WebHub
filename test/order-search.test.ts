import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byPosition, dropReorder, isPermutation, moveItem } from '../src/shared/order.ts';
import { fold, scoreLink, searchLinks } from '../src/shared/search.ts';

test('moveItem mueve hacia delante, hacia atrás y limita índices', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 99), ['b', 'a']);
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b']);
});

test('isPermutation valida reordenaciones', () => {
  assert.ok(isPermutation([1, 2, 3], [3, 1, 2]));
  assert.ok(!isPermutation([1, 2, 3], [1, 2]));
  assert.ok(!isPermutation([1, 2, 3], [1, 2, 2]));
  assert.ok(!isPermutation([1, 2, 3], [1, 2, 4]));
});

test('byPosition ordena por posición y desempata por id', () => {
  const list = [{ id: 3, position: 1 }, { id: 1, position: 1 }, { id: 2, position: 0 }];
  assert.deepEqual(list.sort(byPosition).map((x) => x.id), [2, 1, 3]);
});

const L = (title: string, domain: string, extra: Partial<{ note: string; tags: string[]; clicks: number; familyName: string }> = {}) => ({
  title, domain, url: `https://${domain}/`, note: extra.note ?? '', tags: extra.tags ?? [], clicks: extra.clicks ?? 0, familyName: extra.familyName,
});

test('fold ignora tildes y mayúsculas', () => {
  assert.equal(fold('Acción ÑU'), 'accion ñu'.normalize('NFD').replace(/[̀-ͯ]/g, ''));
});

test('busca en título, dominio, etiquetas y notas', () => {
  const links = [
    L('Panel de OVH', 'ovh.com'),
    L('Cloudflare', 'dash.cloudflare.com', { tags: ['dns'] }),
    L('Facturas', 'example.com', { note: 'acceso con la cuenta de ovh' }),
    L('Correo', 'mail.proton.me', { familyName: 'Proveedores' }),
  ];
  assert.deepEqual(searchLinks(links, 'ovh').map((l) => l.title), ['Panel de OVH', 'Facturas']);
  assert.deepEqual(searchLinks(links, 'dns').map((l) => l.title), ['Cloudflare']);
  assert.deepEqual(searchLinks(links, 'proveedores').map((l) => l.title), ['Correo']);
  assert.deepEqual(searchLinks(links, '   '), []);
});

test('todos los términos deben coincidir', () => {
  const links = [L('Panel de OVH', 'ovh.com'), L('Panel de Hetzner', 'hetzner.com')];
  assert.deepEqual(searchLinks(links, 'panel hetz').map((l) => l.title), ['Panel de Hetzner']);
  assert.equal(scoreLink(links[0]!, 'panel hetz'), 0);
});

test('prioriza coincidencias al inicio del título y desempata por clics', () => {
  const links = [L('Mi git', 'mi.dev'), L('Gitea', 'gitea.io'), L('GitHub', 'github.com', { clicks: 5 })];
  assert.deepEqual(searchLinks(links, 'git').map((l) => l.title), ['GitHub', 'Gitea', 'Mi git']);
  assert.deepEqual(searchLinks(links, 'GIT', 1).map((l) => l.title), ['GitHub']);
});

test('sin tildes encuentra con tildes', () => {
  assert.deepEqual(searchLinks([L('Administración', 'a.es')], 'administracion').map((l) => l.title), ['Administración']);
});

test('dropReorder coloca antes o después del destino', () => {
  assert.deepEqual(dropReorder([1, 2, 3, 4], 1, 3, false), [2, 1, 3, 4]);
  assert.deepEqual(dropReorder([1, 2, 3, 4], 1, 3, true), [2, 3, 1, 4]);
  assert.deepEqual(dropReorder([1, 2, 3, 4], 4, 1, false), [4, 1, 2, 3]);
  assert.deepEqual(dropReorder([1, 2, 3], 2, 2, true), [1, 2, 3]);
  assert.deepEqual(dropReorder([1, 2, 3], 9, 2, true), [1, 2, 3]);
});
