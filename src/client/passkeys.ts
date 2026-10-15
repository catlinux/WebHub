import { api, ApiError } from './api.ts';

const KEY_DEVICE = 'webhub.huella';
const KEY_OFFER = 'webhub.huella.no';

export function passkeysSupported(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && typeof navigator !== 'undefined' && !!navigator?.credentials;
}

export async function platformAvailable(): Promise<boolean> {
  try {
    if (typeof PublicKeyCredential === 'undefined') return false;
    if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function bufferToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBuffer(s: string): ArrayBuffer {
  let str = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad) str += '='.repeat(4 - pad);
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function deviceHasPasskey(): boolean {
  try {
    return localStorage.getItem(KEY_DEVICE) === '1';
  } catch {
    return false;
  }
}

export function markDevicePasskey(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY_DEVICE, '1');
    else localStorage.removeItem(KEY_DEVICE);
  } catch {
    /* sin almacenamiento local */
  }
}

export function passkeyOfferDismissed(): boolean {
  try {
    return localStorage.getItem(KEY_OFFER) === '1';
  } catch {
    return false;
  }
}

export function dismissPasskeyOffer(): void {
  try {
    localStorage.setItem(KEY_OFFER, '1');
  } catch {
    /* sin almacenamiento local */
  }
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Dispositivo';
}

function mensajeGenerico(): Error {
  return new Error('No se pudo completar la operación. Inténtalo de nuevo.');
}

function traducirError(err: unknown, registro: boolean): Error {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return new Error('Operación cancelada o sin respuesta.');
    if (registro && err.name === 'InvalidStateError') {
      markDevicePasskey(true);
      return new Error('Este dispositivo ya tiene una huella registrada.');
    }
    if (err.name === 'AbortError') return mensajeGenerico();
    return mensajeGenerico();
  }
  if (err instanceof Error) return err;
  return mensajeGenerico();
}

export async function registerPasskey(name: string): Promise<void> {
  let options: any;
  try {
    options = await api<any>('POST', '/api/webauthn/register-options');
  } catch (err) {
    throw err instanceof ApiError ? err : traducirError(err, true);
  }

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: b64urlToBuffer(options.challenge) as BufferSource,
    rp: options.rp,
    user: {
      id: b64urlToBuffer(options.user.id) as BufferSource,
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation,
    timeout: options.timeout,
    excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({
      type: c.type,
      id: b64urlToBuffer(c.id) as BufferSource,
    })),
  };

  let cred: PublicKeyCredential | null = null;
  try {
    cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch (err) {
    throw traducirError(err, true);
  }
  if (!cred) throw mensajeGenerico();

  const response = cred.response as AuthenticatorAttestationResponse;
  if (
    typeof response.getPublicKey !== 'function' ||
    typeof response.getPublicKeyAlgorithm !== 'function' ||
    typeof response.getAuthenticatorData !== 'function'
  ) {
    throw new Error('Este navegador no admite huellas con WebHub. Usa el PIN.');
  }

  const pub = response.getPublicKey();
  if (!pub) throw new Error('Este navegador no admite huellas con WebHub. Usa el PIN.');

  try {
    await api('POST', '/api/webauthn/register', {
      id: bufferToB64url(cred.rawId),
      clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
      authenticatorData: bufferToB64url(response.getAuthenticatorData()),
      publicKey: bufferToB64url(pub),
      alg: response.getPublicKeyAlgorithm(),
      name,
    });
  } catch (err) {
    throw err instanceof ApiError ? err : traducirError(err, true);
  }

  markDevicePasskey(true);
}

export async function loginWithPasskey(): Promise<void> {
  let options: any;
  try {
    options = await api<any>('POST', '/api/webauthn/login-options');
  } catch (err) {
    throw err instanceof ApiError ? err : traducirError(err, false);
  }

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: b64urlToBuffer(options.challenge) as BufferSource,
    rpId: options.rpId,
    allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({
      type: c.type,
      id: b64urlToBuffer(c.id) as BufferSource,
    })),
    userVerification: options.userVerification,
    timeout: options.timeout,
  };

  let cred: PublicKeyCredential | null = null;
  try {
    cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  } catch (err) {
    throw traducirError(err, false);
  }
  if (!cred) throw mensajeGenerico();

  const response = cred.response as AuthenticatorAssertionResponse;

  try {
    await api('POST', '/api/webauthn/login', {
      id: bufferToB64url(cred.rawId),
      clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
    });
  } catch (err) {
    throw err instanceof ApiError ? err : traducirError(err, false);
  }

  markDevicePasskey(true);
}
