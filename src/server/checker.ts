import type { Repo } from './repo.ts';
import { describeError, fetchLimited } from './fetcher.ts';
export { classify } from '../shared/check.ts';

export interface CheckJob {
  running: boolean;
  total: number;
  done: number;
  startedAt: string;
  finishedAt: string | null;
}

/** Comprueba una URL: HEAD y, si el servidor no lo admite, GET. Devuelve el estado a guardar. */
export async function checkUrl(url: string): Promise<string> {
  try {
    let r = await fetchLimited(url, { method: 'HEAD', timeoutMs: 10_000 });
    if ([400, 403, 405, 501].includes(r.status)) r = await fetchLimited(url, { timeoutMs: 10_000, maxBytes: 1 });
    return String(r.status);
  } catch (err) {
    return describeError(err);
  }
}

/** Ejecuta la comprobación de todos los enlaces bajo demanda, con concurrencia limitada. */
export class LinkChecker {
  job: CheckJob | null = null;

  private readonly repo: Repo;
  private readonly concurrency: number;
  private readonly check: (url: string) => Promise<string>;

  constructor(repo: Repo, concurrency = 6, check = checkUrl) {
    this.repo = repo;
    this.concurrency = concurrency;
    this.check = check;
  }

  start(): CheckJob {
    if (this.job?.running) return this.job;
    const links = this.repo.snapshot().links.map((l) => ({ id: l.id, url: l.url }));
    const job: CheckJob = { running: true, total: links.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null };
    this.job = job;
    let next = 0;
    const worker = async () => {
      while (next < links.length) {
        const link = links[next++]!;
        const status = await this.check(link.url);
        try {
          this.repo.setCheckResult(link.id, status);
        } catch {
          /* el enlace pudo borrarse mientras tanto */
        }
        job.done++;
      }
    };
    void Promise.all(Array.from({ length: Math.min(this.concurrency, links.length) }, worker)).finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
    return job;
  }
}
