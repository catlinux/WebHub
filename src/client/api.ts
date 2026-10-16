/** Cliente de la API. Todas las peticiones de escritura llevan X-WebHub (protección CSRF). */

export class ApiError extends Error {
  status: number;
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-WebHub': '1' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* respuesta vacía */
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Error ${res.status}`, data);
  }
  return data as T;
}

/** Registra un clic sin bloquear la apertura de la pestaña. */
export function sendClick(id: number): void {
  void fetch(`/api/links/${id}/click`, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'X-WebHub': '1' } }).catch(() => {});
}
