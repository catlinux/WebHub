/** Clasifica el estado guardado por el comprobador: «ok», «aviso» (login, límite, error del servidor…) o «roto». */
export function classify(status: string | null): 'ok' | 'aviso' | 'roto' | null {
  if (!status) return null;
  const code = Number(status);
  if (!Number.isInteger(code)) return status === 'tiempo agotado' ? 'aviso' : 'roto';
  if (code < 400) return 'ok';
  if ([401, 403, 429].includes(code) || code >= 500) return 'aviso';
  return 'roto';
}
