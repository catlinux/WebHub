import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/server/db.ts';
import {
  LoginLimiter, createSession, deleteSession, hashPassword, isValidSession, setPassword, verifyPassword, getPasswordHash,
} from '../src/server/auth.ts';

test('hash scrypt verificable, con sal aleatoria y sin la contraseña en claro', async () => {
  const a = await hashPassword('una clave bastante larga');
  const b = await hashPassword('una clave bastante larga');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.ok(!a.includes('una clave'));
  assert.equal(await verifyPassword('una clave bastante larga', a), true);
  assert.equal(await verifyPassword('una clave bastante largA', a), false);
  assert.equal(await verifyPassword('x', 'basura'), false);
});

test('setPassword exige longitud mínima y cierra sesiones', async () => {
  const db = openDatabase(null);
  await assert.rejects(setPassword(db, 'corta'), /al menos 12/);
  await setPassword(db, 'contraseña-larga-1');
  const { token } = createSession(db, 30);
  assert.ok(isValidSession(db, token));
  await setPassword(db, 'contraseña-larga-2');
  assert.ok(!isValidSession(db, token));
  assert.ok(await verifyPassword('contraseña-larga-2', getPasswordHash(db)!));
});

test('sesiones: caducan, se pueden cerrar y solo se guarda el hash del token', () => {
  const db = openDatabase(null);
  const now = Date.parse('2026-01-01T00:00:00Z');
  const { token } = createSession(db, 1, now);
  assert.ok(isValidSession(db, token, now + 1000));
  assert.ok(!isValidSession(db, token, now + 2 * 86_400_000));
  const stored = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
  assert.notEqual(stored.token_hash, token);
  assert.ok(!isValidSession(db, 'inventado', now));
  assert.ok(!isValidSession(db, undefined, now));
  deleteSession(db, token);
  assert.ok(!isValidSession(db, token, now + 1000));
});

test('LoginLimiter bloquea por IP tras 5 fallos y libera al pasar la ventana', () => {
  let t = 0;
  const lim = new LoginLimiter(5, 100, 60_000, () => t);
  for (let i = 0; i < 5; i++) {
    assert.equal(lim.retryAfter('1.1.1.1'), 0);
    lim.fail('1.1.1.1');
    t += 1000;
  }
  assert.ok(lim.retryAfter('1.1.1.1') > 0);
  assert.equal(lim.retryAfter('2.2.2.2'), 0, 'otra IP no queda bloqueada');
  t = 60_001;
  assert.equal(lim.retryAfter('1.1.1.1'), 0, 'el primer fallo ya salió de la ventana');
});

test('LoginLimiter: el éxito limpia la IP y hay tope global', () => {
  let t = 0;
  const lim = new LoginLimiter(3, 4, 60_000, () => t);
  lim.fail('a');
  lim.fail('a');
  lim.succeed('a');
  lim.fail('a');
  assert.equal(lim.retryAfter('a'), 0);
  lim.fail('b');
  lim.fail('c');
  assert.ok(lim.retryAfter('zz') > 0, 'cuatro fallos globales bloquean a todos');
});
