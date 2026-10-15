import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/server/db.ts';
import {
  LoginLimiter, createSession, deleteSession, hashSecret, isValidSession, setPin, verifySecret, getPinHash,
} from '../src/server/auth.ts';

test('hash scrypt verificable, con sal aleatoria y sin el PIN en claro', async () => {
  const a = await hashSecret('48151623');
  const b = await hashSecret('48151623');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.ok(!a.includes('48151623'));
  assert.equal(await verifySecret('48151623', a), true);
  assert.equal(await verifySecret('48151624', a), false);
  assert.equal(await verifySecret('1', 'basura'), false);
});

test('setPin solo admite de 6 a 12 dígitos y cierra sesiones', async () => {
  const db = openDatabase(null);
  for (const bad of ['12345', '1234567890123', '12345a', ' 123456', '12 3456', '']) {
    await assert.rejects(setPin(db, bad), /6 a 12 dígitos/, bad);
  }
  await setPin(db, '135790');
  const { token } = createSession(db, 30);
  assert.ok(isValidSession(db, token));
  await setPin(db, '24681012');
  assert.ok(!isValidSession(db, token));
  assert.ok(await verifySecret('24681012', getPinHash(db)!));
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
  const lim = new LoginLimiter({ maxPerIp: 5, windowMs: 60_000, streakLimit: 1000, clock: () => t });
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

test('LoginLimiter: bloqueo global escalonado (15 min, 30 min, 1 h… hasta 24 h)', () => {
  let t = 0;
  const min = 60_000;
  const lim = new LoginLimiter({ maxPerIp: 1000, streakLimit: 10, baseLockMs: 15 * min, maxLockMs: 24 * 60 * min, clock: () => t });
  const burst = () => {
    let lock = 0;
    for (let i = 0; i < 10; i++) lock = lim.fail(`10.0.0.${i}`); // IP distintas: el límite por IP no basta
    return lock;
  };
  assert.equal(burst(), 15 * min);
  assert.equal(lim.retryAfter('otra'), 15 * 60, 'bloquea a todas las IP');
  t += 15 * min;
  assert.equal(lim.retryAfter('otra'), 0);
  assert.equal(burst(), 30 * min);
  t += 30 * min;
  assert.equal(burst(), 60 * min);
  for (let i = 0; i < 10; i++) {
    t += 24 * 60 * min;
    burst();
  }
  t += 1;
  assert.equal(lim.retryAfter('otra'), 24 * 3600, 'tope de 24 h');
});

test('LoginLimiter: un acierto reinicia la racha y el bloqueo', () => {
  let t = 0;
  const lim = new LoginLimiter({ maxPerIp: 3, streakLimit: 3, clock: () => t });
  lim.fail('a');
  lim.fail('a');
  lim.succeed('a');
  assert.equal(lim.fail('a'), 0, 'la racha empezó de nuevo');
  assert.equal(lim.retryAfter('a'), 0);
});
