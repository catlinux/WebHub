import { createHash, randomBytes, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export class WebAuthnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

export function b64urlEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function b64urlDecode(s: string): Buffer {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new WebAuthnError('entrada base64url inválida');
  }
  return Buffer.from(s, 'base64url');
}

export const ALGS = {
  ES256: -7,
  RS256: -257,
  EdDSA: -8,
} as const;

type ChallengeEntry = { expiry: number };

export class ChallengeStore {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, ChallengeEntry>();

  constructor(opts: { ttlMs?: number; max?: number; clock?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.max = opts.max ?? 200;
    this.clock = opts.clock ?? Date.now;
  }

  create(): string {
    const now = this.clock();
    if (this.entries.size >= this.max) {
      // Primero descartar los caducados.
      for (const [key, entry] of this.entries) {
        if (entry.expiry <= now) this.entries.delete(key);
      }
      // Luego los más antiguos hasta tener hueco.
      while (this.entries.size >= this.max && this.entries.size > 0) {
        const oldest = this.entries.keys().next().value as string;
        this.entries.delete(oldest);
      }
    }
    const challenge = b64urlEncode(randomBytes(32));
    this.entries.set(challenge, { expiry: now + this.ttlMs });
    return challenge;
  }

  consume(challenge: string): boolean {
    if (typeof challenge !== 'string') return false;
    const entry = this.entries.get(challenge);
    if (entry === undefined) return false;
    this.entries.delete(challenge);
    return this.clock() < entry.expiry;
  }
}

type RegistrationInput = {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  publicKey: string;
  alg: number;
  origin: string;
  rpId: string;
  challenges: ChallengeStore;
};

type AssertionInput = {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  publicKey: string;
  alg: number;
  storedCounter: number;
  origin: string;
  rpId: string;
  challenges: ChallengeStore;
};

function sha256Buffer(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function readUInt32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function verifyRegistrationImpl(input: RegistrationInput): { credentialId: string; publicKey: string; alg: number; signCount: number } {
  // clientDataJSON.
  const clientDataBytes = b64urlDecode(input.clientDataJSON);
  let clientData: any;
  try {
    clientData = JSON.parse(clientDataBytes.toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON inválido');
  }
  if (!clientData || typeof clientData !== 'object') throw new WebAuthnError('clientDataJSON inválido');
  if (clientData.type !== 'webauthn.create') throw new WebAuthnError('tipo de cliente inválido');

  if (typeof clientData.challenge !== 'string') throw new WebAuthnError('reto inválido');
  const consumed = input.challenges.consume(clientData.challenge);
  if (!consumed) throw new WebAuthnError('reto inválido');

  if (clientData.origin !== input.origin) throw new WebAuthnError('origen inválido');
  if (clientData.crossOrigin === true) throw new WebAuthnError('origen inválido');

  const authData = b64urlDecode(input.authenticatorData);
  if (authData.length < 37) throw new WebAuthnError('authenticatorData inválido');

  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = sha256Buffer(input.rpId);
  if (rpIdHash.length !== expectedRpIdHash.length || !timingSafeEqual(rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError('rpId inválido');
  }

  const flags = authData[32];
  if (!((flags & 0x01) && (flags & 0x04))) throw new WebAuthnError('banderas inválidas');
  const signCount = readUInt32BE(authData, 33);

  if (!(flags & 0x40)) throw new WebAuthnError('banderas inválidas');

  // Datos de credencial tras los 37 bytes.
  let offset = 37;
  if (authData.length < offset + 16 + 2) throw new WebAuthnError('authenticatorData inválido');
  offset += 16; // aaguid
  const credIdLen = authData.readUInt16BE(offset);
  offset += 2;
  if (authData.length < offset + credIdLen) throw new WebAuthnError('authenticatorData inválido');
  const credId = authData.subarray(offset, offset + credIdLen);
  offset += credIdLen;

  const inputIdBytes = b64urlDecode(input.id);
  if (credId.length !== inputIdBytes.length || !timingSafeEqual(credId, inputIdBytes)) {
    throw new WebAuthnError('id de credencial inválido');
  }

  if (input.alg !== ALGS.ES256 && input.alg !== ALGS.RS256 && input.alg !== ALGS.EdDSA) {
    throw new WebAuthnError('algoritmo no soportado');
  }

  const spki = b64urlDecode(input.publicKey);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new WebAuthnError('clave pública inválida');
  }

  const details = key.asymmetricKeyDetails as { namedCurve?: string; modulusLength?: number } | undefined;
  if (input.alg === ALGS.ES256) {
    if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') {
      throw new WebAuthnError('clave pública inválida');
    }
  } else if (input.alg === ALGS.RS256) {
    if (key.asymmetricKeyType !== 'rsa' || (details?.modulusLength ?? 0) < 2048) {
      throw new WebAuthnError('clave pública inválida');
    }
  } else {
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new WebAuthnError('clave pública inválida');
    }
  }

  return {
    credentialId: input.id,
    publicKey: input.publicKey,
    alg: input.alg,
    signCount,
  };
}

export function verifyRegistration(input: RegistrationInput): { credentialId: string; publicKey: string; alg: number; signCount: number } {
  try {
    return verifyRegistrationImpl(input);
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError('verificación de registro inválida');
  }
}

function verifyAssertionImpl(input: AssertionInput): { signCount: number } {
  const clientDataBytes = b64urlDecode(input.clientDataJSON);
  let clientData: any;
  try {
    clientData = JSON.parse(clientDataBytes.toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON inválido');
  }
  if (!clientData || typeof clientData !== 'object') throw new WebAuthnError('clientDataJSON inválido');
  if (clientData.type !== 'webauthn.get') throw new WebAuthnError('tipo de cliente inválido');

  if (typeof clientData.challenge !== 'string') throw new WebAuthnError('reto inválido');
  if (!input.challenges.consume(clientData.challenge)) throw new WebAuthnError('reto inválido');

  if (clientData.origin !== input.origin) throw new WebAuthnError('origen inválido');
  if (clientData.crossOrigin === true) throw new WebAuthnError('origen inválido');

  const authData = b64urlDecode(input.authenticatorData);
  if (authData.length < 37) throw new WebAuthnError('authenticatorData inválido');

  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = sha256Buffer(input.rpId);
  if (rpIdHash.length !== expectedRpIdHash.length || !timingSafeEqual(rpIdHash, expectedRpIdHash)) {
    throw new WebAuthnError('rpId inválido');
  }

  const flags = authData[32];
  if (!((flags & 0x01) && (flags & 0x04))) throw new WebAuthnError('banderas inválidas');

  const newCount = readUInt32BE(authData, 33);

  const spki = b64urlDecode(input.publicKey);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw new WebAuthnError('clave pública inválida');
  }

  if (input.alg !== ALGS.ES256 && input.alg !== ALGS.RS256 && input.alg !== ALGS.EdDSA) {
    throw new WebAuthnError('algoritmo no soportado');
  }

  const data = Buffer.concat([authData, sha256Buffer(clientDataBytes)]);
  const signature = b64urlDecode(input.signature);

  let ok = false;
  try {
    if (input.alg === ALGS.ES256) {
      ok = verify('sha256', data, { key, dsaEncoding: 'der' } as any, signature);
    } else if (input.alg === ALGS.RS256) {
      ok = verify('sha256', data, key, signature);
    } else {
      ok = verify(null as any, data, key, signature);
    }
  } catch {
    throw new WebAuthnError('firma inválida');
  }
  if (!ok) throw new WebAuthnError('firma inválida');

  // Contador.
  if (!(newCount === 0 && input.storedCounter === 0)) {
    if (!(newCount > input.storedCounter)) throw new WebAuthnError('contador inválido (posible clon)');
  }

  return { signCount: newCount };
}

export function verifyAssertion(input: AssertionInput): { signCount: number } {
  try {
    return verifyAssertionImpl(input);
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError('verificación de aserción inválida');
  }
}