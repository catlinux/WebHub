/** Clasifica el estado guardado por el comprobador: «ok», «protegido», «privado», «aviso», «roto» o «ignorado». */
export function classify(status: string | null, url?: string, ignored?: boolean): 'ok' | 'protegido' | 'privado' | 'aviso' | 'roto' | 'ignorado' | null {
  if (!status) return null;
  if (ignored === true) return 'ignorado';
  const code = Number(status);
  if (!Number.isInteger(code)) return status === 'tiempo agotado' ? 'aviso' : 'roto';
  if (code < 400) return 'ok';
  if (code === 401 || code === 403) return 'protegido';
  if ((code === 404 || code === 410) && isGitHubUrl(url)) return 'privado';
  if (code === 429 || code >= 500) return 'aviso';
  return 'roto';
}

function isGitHubUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'github.com' || host === 'www.github.com';
  } catch {
    return false;
  }
}