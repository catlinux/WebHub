import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  b64urlEncode,
  b64urlDecode,
  WebAuthnError,
  ChallengeStore,
  ALGS,
  verifyRegistration,
  verifyAssertion,
} from '../src/server/webauthn.ts';

function b64u(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function sha256(buf: Buffer | Uint8Array | string): Buffer {
  return crypto.createHash('sha256').update(buf).digest();
}

function clientData(type: string, challenge: string, origin: string, crossOrigin?: boolean): string {
  const obj: Record<string, unknown> = { type, challenge, origin };
  if (crossOrigin !== undefined) obj.crossOrigin = crossOrigin;
  return b64u(Buffer.from(JSON.stringify(obj)));
}

function makeAuthData(rpId: string, flags: number, counter: number, credId?: Buffer): Buffer {
  if (credId) {
    const buf = Buffer.alloc(37 + 16 + 2 + credId.length);
    sha256(rpId).copy(buf, 0);
    buf[32] = flags;
    buf.writeUInt32BE(counter, 33);
    buf.writeUInt16BE(credId.length, 37 + 16);
    credId.copy(buf, 37 + 16 + 2);
    return buf;
  }
  const buf = Buffer.alloc(37);
  sha256(rpId).copy(buf, 0);
  buf[32] = flags;
  buf.writeUInt32BE(counter, 33);
  return buf;
}

function genKey(alg: number) {
  if (alg === ALGS.ES256) {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  }
  if (alg === ALGS.RS256) {
    return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  }
  return crypto.generateKeyPairSync('ed25519');
}

function signData(alg: number, privateKey: crypto.KeyObject, data: Buffer): Buffer {
  if (alg === ALGS.ES256) return crypto.sign('sha256', data, privateKey);
  if (alg === ALGS.RS256) return crypto.sign('sha256', data, privateKey);
  return crypto.sign(null, data, privateKey);
}

const ORIGIN = 'https://example.com';
const RP_ID = 'example.com';

test('b64url codifica y decodifica', () => {
  const buf = crypto.randomBytes(32);
  assert.equal(b64urlDecode(b64urlEncode(buf)).equals(buf), true);
});

test('b64urlDecode rechaza caracteres fuera del alfabeto', () => {
  assert.throws(() => b64urlDecode('a+b/c='), WebAuthnError);
  assert.throws(() => b64urlDecode('abcd!'), WebAuthnError);
});

test('ChallengeStore: consume un solo uso y expira con reloj inyectable', () => {
  let t = 0;
  const store = new ChallengeStore({ ttlMs: 10, clock: () => t });
  const c = store.create();
  assert.equal(store.consume(c), true);
  assert.equal(store.consume(c), false);
  const c2 = store.create();
  t = 20;
  assert.equal(store.consume(c2), false);
});

test('ChallengeStore: reto desconocido devuelve false', () => {
  const store = new ChallengeStore();
  assert.equal(store.consume('desconocido'), false);
});

test('ChallengeStore: límite max descarta los más antiguos', () => {
  const store = new ChallengeStore({ max: 2 });
  const a = store.create();
  const b = store.create();
  store.create();
  assert.equal(store.consume(a), false);
  assert.equal(store.consume(b), true);
});

test('ALGS tiene los valores correctos', () => {
  assert.equal(ALGS.ES256, -7);
  assert.equal(ALGS.RS256, -257);
  assert.equal(ALGS.EdDSA, -8);
});

for (const alg of [ALGS.ES256, ALGS.RS256, ALGS.EdDSA]) {
  test(`registro feliz ${alg}`, () => {
    const store = new ChallengeStore();
    const challenge = store.create();
    const { publicKey, privateKey: _pk } = genKey(alg);
    void _pk;
    const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
    const credId = crypto.randomBytes(16);
    const auth = makeAuthData(RP_ID, 0x45, 42, credId);
    const cd = clientData('webauthn.create', challenge, ORIGIN);
    const input = {
      id: b64u(credId),
      clientDataJSON: cd,
      authenticatorData: b64u(auth),
      publicKey: b64u(spki),
      alg,
      origin: ORIGIN,
      rpId: RP_ID,
      challenges: store,
    };
    const res = verifyRegistration(input);
    assert.equal(res.credentialId, input.id);
    assert.equal(res.publicKey, input.publicKey);
    assert.equal(res.alg, alg);
    assert.equal(res.signCount, 42);
  });
}

test('registro: reto reutilizado falla', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  verifyRegistration({ ...input });
  assert.throws(() => verifyRegistration({ ...input }), WebAuthnError);
  assert.equal(store.consume(challenge), false);
});

test('registro: reto consumido aunque la verificación falle después', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: 'https://otro.com',
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /origen/);
  assert.equal(store.consume(challenge), false);
});

test('registro: reto caducado', () => {
  let t = 0;
  const store = new ChallengeStore({ ttlMs: 10, clock: () => t });
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  t = 20;
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /reto/);
});

test('registro: reto desconocido', () => {
  const store = new ChallengeStore();
  const challenge = 'desconocido';
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /reto/);
});

test('registro: origin incorrecto', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: 'https://otro.com',
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /origen/);
});

test('registro: rpId incorrecto', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: 'otro.com',
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /rpId/);
});

test('registro: sin UV', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x41, 0, credId); // UP+AT, no UV
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /banderas/);
});

test('registro: sin UP', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x44, 0, credId); // UV+AT
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /banderas/);
});

test('registro: type incorrecto', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /tipo/);
});

test('registro: crossOrigin true rechazado', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN, true);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /origen/);
});

test('registro: authenticatorData truncado', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId).subarray(0, 36);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /authenticatorData/);
});

test('registro: id de credencial distinto del de authenticatorData', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(crypto.randomBytes(16)),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /id de credencial/);
});

test('registro: algoritmo que no corresponde a la clave', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.RS256); // RSA key
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: ALGS.ES256, // dice EC
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /clave pública/);
});

test('registro: alg no soportado', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const credId = crypto.randomBytes(16);
  const auth = makeAuthData(RP_ID, 0x45, 0, credId);
  const cd = clientData('webauthn.create', challenge, ORIGIN);
  const input = {
    id: b64u(credId),
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    publicKey: b64u(spki),
    alg: -999,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyRegistration(input), /algoritmo/);
});

// ---- assertion tests ----

function buildAssertion(alg: number, counter: number, storedCounter: number) {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(alg);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, counter);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(alg, privateKey as crypto.KeyObject, data);
  return { store, cd, auth, sig, spki, counter, storedCounter, alg, privateKey, challenge, cdBytes };
}

test('entrada feliz P-256 verifica firma', () => {
  const { store, cd, auth, sig, spki, counter, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  const res = verifyAssertion(input);
  assert.equal(res.signCount, counter);
});

// Run happy for all algs
for (const alg of [ALGS.ES256, ALGS.RS256, ALGS.EdDSA]) {
  test(`entrada feliz ${alg}`, () => {
    const { store, cd, auth, sig, spki, counter, storedCounter } = buildAssertion(alg, 7, 2);
    const input = {
      clientDataJSON: cd,
      authenticatorData: b64u(auth),
      signature: b64u(sig),
      publicKey: b64u(spki),
      alg,
      storedCounter,
      origin: ORIGIN,
      rpId: RP_ID,
      challenges: store,
    };
    const res = verifyAssertion(input);
    assert.equal(res.signCount, counter);
  });
}

test('entrada: firma alterada (un bit) falla', () => {
  const { store, cd, auth, sig, spki, counter, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const badSig = Buffer.from(sig);
  badSig[0] ^= 1;
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(badSig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /firma/);
});

test('entrada: firma de otra clave falla', () => {
  const a = buildAssertion(ALGS.ES256, 5, 0);
  const other = genKey(ALGS.ES256);
  const otherSpki = (other.publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  // sign with original key already in a; verify uses other public key
  const input = {
    clientDataJSON: a.cd,
    authenticatorData: b64u(a.auth),
    signature: b64u(a.sig),
    publicKey: b64u(otherSpki),
    alg: ALGS.ES256,
    storedCounter: a.storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: a.store,
  };
  assert.throws(() => verifyAssertion(input), /firma/);
});

test('entrada: authenticatorData alterado tras firmar falla', () => {
  const { store, cd, auth, sig, spki, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const badAuth = Buffer.from(auth);
  badAuth[32] ^= 0x04; // quita UV
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(badAuth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), WebAuthnError);
});

test('entrada: algoritmo que no corresponde a la clave falla', () => {
  const { store, cd, auth, sig } = buildAssertion(ALGS.ES256, 5, 0);
  const { publicKey: rsaPub } = genKey(ALGS.RS256);
  const rsaSpki = (rsaPub as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(rsaSpki),
    alg: ALGS.ES256,
    storedCounter: 0,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), WebAuthnError);
});

test('entrada: challenge reutilizado falla', () => {
  const { store, cd, auth, sig, spki, counter, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  verifyAssertion({ ...input });
  assert.throws(() => verifyAssertion({ ...input }), /reto/);
});

test('entrada: origin incorrecto', () => {
  const { store, cd, auth, sig, spki, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: 'https://otro.com',
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /origen/);
});

test('entrada: rpId incorrecto', () => {
  const { store, cd, auth, sig, spki, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: 'otro.com',
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /rpId/);
});

test('entrada: sin UV', () => {
  const { store, sig, spki, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const auth = makeAuthData(RP_ID, 0x01, 5); // UP only
  const cd = clientData('webauthn.get', 'x', ORIGIN); // won't match challenge but auth flags checked after challenge; need valid challenge
  // Rebuild properly:
  const store2 = new ChallengeStore();
  const challenge = store2.create();
  const cd2 = clientData('webauthn.get', challenge, ORIGIN);
  const auth2 = makeAuthData(RP_ID, 0x01, 5);
  const cdBytes = b64urlDecode(cd2);
  const data = Buffer.concat([auth2, sha256(cdBytes)]);
  const { privateKey } = genKey(alg);
  const spki2 = spki;
  const sig2 = signData(alg, (privateKey as any), data);
  const input = {
    clientDataJSON: cd2,
    authenticatorData: b64u(auth2),
    signature: b64u(sig2),
    publicKey: b64u(spki2),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store2,
  };
  assert.throws(() => verifyAssertion(input), /banderas/);
  void store; void sig; void cd; void auth; void spki;
});

test('entrada: sin UP', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x04, 5); // UV only
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(ALGS.ES256, privateKey as crypto.KeyObject, data);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 0,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /banderas/);
});

test('entrada: type incorrecto', () => {
  const { store, cd, auth, sig, spki, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  // rebuild clientData as create
  const store2 = new ChallengeStore();
  const challenge2 = store2.create();
  const cdCreate = clientData('webauthn.create', challenge2, ORIGIN);
  // not verifying signature validity, type check happens before signature maybe after challenge; challenge consumed
  const input = {
    clientDataJSON: cdCreate,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store2,
  };
  assert.throws(() => verifyAssertion(input), /tipo/);
  void cd;
});

test('entrada: crossOrigin true rechazado', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, 5);
  const cd = clientData('webauthn.get', challenge, ORIGIN, true);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(ALGS.ES256, privateKey as crypto.KeyObject, data);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 0,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /origen/);
});

test('entrada: authenticatorData truncado', () => {
  const { store, cd, sig, spki, storedCounter, alg } = buildAssertion(ALGS.ES256, 5, 0);
  const auth = makeAuthData(RP_ID, 0x05, 5).subarray(0, 36);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg,
    storedCounter,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /authenticatorData/);
});

test('entrada: contador retrocede con storedCounter > 0 rechazado', () => {
  // sign with counter 3 but storedCounter 5
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, 3);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(ALGS.ES256, privateKey as crypto.KeyObject, data);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 5,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /contador/);
});

test('entrada: contador repetido con storedCounter > 0 rechazado', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, 5);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(ALGS.ES256, privateKey as crypto.KeyObject, data);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 5,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /contador/);
});

test('entrada: contador 0 con storedCounter 0 aceptado', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, 0);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(ALGS.ES256, privateKey as crypto.KeyObject, data);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 0,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  const res = verifyAssertion(input);
  assert.equal(res.signCount, 0);
});

test('consume borra aunque la verificación falle', () => {
  const store = new ChallengeStore();
  const challenge = store.create();
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, 5);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  // signature inválida a propósito
  const sig = crypto.randomBytes(72);
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 0,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), WebAuthnError);
  assert.equal(store.consume(challenge), false);
  // privateKey unused
  void privateKey;
});

test('reto que caduca usa reloj inyectable (assertion)', () => {
  let t = 0;
  const store = new ChallengeStore({ ttlMs: 10, clock: () => t });
  const challenge = store.create();
  // rebuild with fixed challenge already consumed by store; need new challenge after t? use previous
  const { publicKey, privateKey } = genKey(ALGS.ES256);
  const spki = (publicKey as crypto.KeyObject).export({ type: 'spki', format: 'der' }) as Buffer;
  const auth = makeAuthData(RP_ID, 0x05, 5);
  const cd = clientData('webauthn.get', challenge, ORIGIN);
  const cdBytes = b64urlDecode(cd);
  const data = Buffer.concat([auth, sha256(cdBytes)]);
  const sig = signData(ALGS.ES256, privateKey as crypto.KeyObject, data);
  t = 20;
  const input = {
    clientDataJSON: cd,
    authenticatorData: b64u(auth),
    signature: b64u(sig),
    publicKey: b64u(spki),
    alg: ALGS.ES256,
    storedCounter: 0,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
  assert.throws(() => verifyAssertion(input), /reto/);
});

function registroConClave(alg: number, publicKey: crypto.KeyObject) {
  const store = new ChallengeStore();
  const credId = crypto.randomBytes(16);
  return {
    id: b64u(credId),
    clientDataJSON: clientData('webauthn.create', store.create(), ORIGIN),
    authenticatorData: b64u(makeAuthData(RP_ID, 0x45, 0, credId)),
    publicKey: b64u(publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
    alg,
    origin: ORIGIN,
    rpId: RP_ID,
    challenges: store,
  };
}

test('registro: RSA de menos de 2048 bits rechazada', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => verifyRegistration(registroConClave(ALGS.RS256, publicKey)), WebAuthnError);
});

test('registro: ES256 solo admite la curva P-256', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => verifyRegistration(registroConClave(ALGS.ES256, publicKey)), WebAuthnError);
});
