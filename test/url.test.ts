import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainOf, duplicateKey, normalizeUrl, parseTags } from '../src/shared/url.ts';

test('normalizeUrl acepta http(s) y añade https si falta', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  http://Example.com/a '), 'http://example.com/a');
  assert.equal(normalizeUrl('localhost:8080/x'), 'https://localhost:8080/x');
  assert.equal(normalizeUrl('192.168.1.10:8006'), 'https://192.168.1.10:8006/');
});

test('normalizeUrl rechaza esquemas peligrosos', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,hola', 'file:///etc/passwd', 'vbscript:x', '', '   ']) {
    assert.equal(normalizeUrl(bad), null, bad);
  }
});

test('domainOf quita www', () => {
  assert.equal(domainOf('https://www.ovh.com/es/'), 'ovh.com');
  assert.equal(domainOf('no es url'), '');
});

test('duplicateKey iguala variantes de la misma URL', () => {
  const k = duplicateKey('https://www.Example.com/ruta/?b=2&a=1#x');
  assert.equal(duplicateKey('http://example.com/ruta?a=1&b=2'), k);
  assert.notEqual(duplicateKey('https://example.com/otra'), k);
});

test('parseTags limpia y quita repetidos', () => {
  assert.deepEqual(parseTags(' linux, Noticias ,linux,, LINUX '), ['linux', 'Noticias']);
  assert.deepEqual(parseTags(['a', ' b ']), ['a', 'b']);
});
