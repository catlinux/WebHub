import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { domainOf, duplicateKey, normalizeUrl, parseTags } from '../shared/url.ts';
import { isPermutation } from '../shared/order.ts';
import type { ImportPlan } from '../shared/bookmarks.ts';
import type { Family, Link, Snapshot } from '../shared/types.ts';

/** Error de validación: se devuelve al cliente como 400 con este mensaje. */
export class InputError extends Error {}

interface FamilyRow { id: number; parent_id: number | null; name: string; position: number; collapsed: number }
interface LinkRow {
  id: number; family_id: number; title: string; url: string; note: string; tags: string; favorite: number;
  position: number; clicks: number; last_click_at: string | null; check_status: string | null; checked_at: string | null;
  check_ignored: number;
}

const toFamily = (r: FamilyRow): Family => ({ id: r.id, parentId: r.parent_id, name: r.name, position: r.position, collapsed: r.collapsed === 1 });
const toLink = (r: LinkRow): Link => ({
  id: r.id,
  familyId: r.family_id,
  title: r.title,
  url: r.url,
  domain: domainOf(r.url),
  note: r.note,
  tags: safeTags(r.tags),
  favorite: r.favorite === 1,
  position: r.position,
  clicks: r.clicks,
  lastClickAt: r.last_click_at,
  checkStatus: r.check_status,
  checkedAt: r.checked_at,
  checkIgnored: r.check_ignored === 1,
});

function safeTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function text(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new InputError(`Falta «${field}».`);
    return '';
  }
  if (typeof value !== 'string') throw new InputError(`«${field}» debe ser texto.`);
  const out = value.replace(/\s+/g, ' ').trim();
  if (required && !out) throw new InputError(`«${field}» no puede estar vacío.`);
  if (out.length > max) throw new InputError(`«${field}» es demasiado largo (máx. ${max}).`);
  return out;
}

function url(value: unknown): string {
  const u = typeof value === 'string' ? normalizeUrl(value) : null;
  if (!u) throw new InputError('La URL no es válida (solo se admiten http y https).');
  if (u.length > 2000) throw new InputError('La URL es demasiado larga.');
  return u;
}

const nowIso = () => new Date().toISOString();

export class Repo {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  snapshot(): Snapshot {
    const families = (this.db.prepare('SELECT * FROM families ORDER BY position, id').all() as unknown as FamilyRow[]).map(toFamily);
    const links = (this.db.prepare('SELECT * FROM links ORDER BY position, id').all() as unknown as LinkRow[]).map(toLink);
    return { families, links };
  }

  private family(id: number): FamilyRow {
    const row = this.db.prepare('SELECT * FROM families WHERE id = ?').get(id) as FamilyRow | undefined;
    if (!row) throw new InputError('La familia no existe.');
    return row;
  }

  private link(id: number): LinkRow {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id) as LinkRow | undefined;
    if (!row) throw new InputError('El enlace no existe.');
    return row;
  }

  /** Solo hay dos niveles: el padre ha de ser una familia de primer nivel. */
  private checkParent(parentId: unknown, selfId?: number): number | null {
    if (parentId === null || parentId === undefined) return null;
    if (typeof parentId !== 'number') throw new InputError('Familia padre no válida.');
    const parent = this.family(parentId);
    if (parent.parent_id !== null) throw new InputError('Las subfamilias no pueden tener subfamilias.');
    if (selfId !== undefined) {
      if (parentId === selfId) throw new InputError('Una familia no puede ser su propia subfamilia.');
      const kids = this.db.prepare('SELECT COUNT(*) AS n FROM families WHERE parent_id = ?').get(selfId) as { n: number };
      if (kids.n > 0) throw new InputError('Esta familia tiene subfamilias: no puede convertirse en subfamilia.');
    }
    return parentId;
  }

  private nextFamilyPosition(parentId: number | null): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM families WHERE parent_id IS ?').get(parentId) as { p: number };
    return row.p;
  }

  private nextLinkPosition(familyId: number): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM links WHERE family_id = ?').get(familyId) as { p: number };
    return row.p;
  }

  createFamily(input: { name?: unknown; parentId?: unknown; collapsed?: unknown }): Family {
    const name = text(input.name, 'nombre', 80, true);
    const parentId = this.checkParent(input.parentId);
    let collapsed = 0;
    if (input.collapsed !== undefined) {
      if (typeof input.collapsed !== 'boolean') throw new InputError('El campo plegada debe ser verdadero o falso.');
      collapsed = input.collapsed ? 1 : 0;
    }
    const r = this.db
      .prepare('INSERT INTO families (parent_id, name, position, collapsed) VALUES (?, ?, ?, ?)')
      .run(parentId, name, this.nextFamilyPosition(parentId), collapsed);
    return toFamily(this.family(Number(r.lastInsertRowid)));
  }

  updateFamily(id: number, input: { name?: unknown; parentId?: unknown; collapsed?: unknown }): Family {
    const current = this.family(id);
    const name = input.name === undefined ? current.name : text(input.name, 'nombre', 80, true);
    let parentId = current.parent_id;
    let position = current.position;
    if (input.parentId !== undefined && input.parentId !== current.parent_id) {
      parentId = this.checkParent(input.parentId, id);
      position = this.nextFamilyPosition(parentId);
    }
    let collapsed = current.collapsed;
    if (input.collapsed !== undefined) {
      if (typeof input.collapsed !== 'boolean') throw new InputError('El campo plegada debe ser verdadero o falso.');
      collapsed = input.collapsed ? 1 : 0;
    }
    this.db.prepare('UPDATE families SET name = ?, parent_id = ?, position = ?, collapsed = ? WHERE id = ?').run(name, parentId, position, collapsed, id);
    return toFamily(this.family(id));
  }

  /** Borra la familia, sus subfamilias y todos sus enlaces. */
  deleteFamily(id: number): void {
    this.family(id);
    this.db.prepare('DELETE FROM families WHERE id = ?').run(id);
  }

  reorderFamilies(parentId: number | null, ids: unknown): void {
    const current = (this.db.prepare('SELECT id FROM families WHERE parent_id IS ?').all(parentId) as { id: number }[]).map((r) => r.id);
    if (!Array.isArray(ids) || !isPermutation(current, ids as number[])) throw new InputError('Orden no válido: recarga la página.');
    const stmt = this.db.prepare('UPDATE families SET position = ? WHERE id = ?');
    transaction(this.db, () => (ids as number[]).forEach((fid, i) => stmt.run(i, fid)));
  }

  createLink(input: Record<string, unknown>): Link {
    const familyId = Number(input.familyId);
    this.family(familyId);
    const u = url(input.url);
    const title = text(input.title, 'título', 300) || domainOf(u);
    const r = this.db
      .prepare('INSERT INTO links (family_id, title, url, note, tags, favorite, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        familyId,
        title,
        u,
        text(input.note, 'nota', 500),
        JSON.stringify(parseTags((input.tags as string | string[]) ?? '')),
        input.favorite ? 1 : 0,
        this.nextLinkPosition(familyId),
      );
    return toLink(this.link(Number(r.lastInsertRowid)));
  }

  updateLink(id: number, input: Record<string, unknown>): Link {
    const cur = this.link(id);
    let familyId = cur.family_id;
    let position = cur.position;
    if (input.familyId !== undefined && Number(input.familyId) !== cur.family_id) {
      familyId = Number(input.familyId);
      this.family(familyId);
      position = this.nextLinkPosition(familyId);
    }
    const u = input.url === undefined ? cur.url : url(input.url);
    const title = input.title === undefined ? cur.title : text(input.title, 'título', 300) || domainOf(u);
    const note = input.note === undefined ? cur.note : text(input.note, 'nota', 500);
    const tags = input.tags === undefined ? cur.tags : JSON.stringify(parseTags(input.tags as string | string[]));
    const favorite = input.favorite === undefined ? cur.favorite : input.favorite ? 1 : 0;
    let checkIgnored = cur.check_ignored;
    if (input.checkIgnored !== undefined) {
      if (typeof input.checkIgnored !== 'boolean') throw new InputError('El campo checkIgnored debe ser verdadero o falso.');
      checkIgnored = input.checkIgnored ? 1 : 0;
    }
    const urlChanged = u !== cur.url;
    this.db
      .prepare(
        `UPDATE links SET family_id = ?, position = ?, title = ?, url = ?, note = ?, tags = ?, favorite = ?, check_ignored = ?, updated_at = ?,
         check_status = CASE WHEN ? THEN NULL ELSE check_status END, checked_at = CASE WHEN ? THEN NULL ELSE checked_at END
         WHERE id = ?`,
      )
      .run(familyId, position, title, u, note, tags, favorite, checkIgnored, nowIso(), urlChanged ? 1 : 0, urlChanged ? 1 : 0, id);
    return toLink(this.link(id));
  }

  deleteLink(id: number): void {
    this.link(id);
    this.db.prepare('DELETE FROM links WHERE id = ?').run(id);
  }

  reorderLinks(familyId: number, ids: unknown): void {
    this.family(familyId);
    const current = (this.db.prepare('SELECT id FROM links WHERE family_id = ?').all(familyId) as { id: number }[]).map((r) => r.id);
    if (!Array.isArray(ids) || !isPermutation(current, ids as number[])) throw new InputError('Orden no válido: recarga la página.');
    const stmt = this.db.prepare('UPDATE links SET position = ? WHERE id = ?');
    transaction(this.db, () => (ids as number[]).forEach((lid, i) => stmt.run(i, lid)));
  }

  registerClick(id: number): void {
    this.db.prepare('UPDATE links SET clicks = clicks + 1, last_click_at = ? WHERE id = ?').run(nowIso(), id);
  }

  setCheckResult(id: number, status: string): void {
    this.db.prepare('UPDATE links SET check_status = ?, checked_at = ? WHERE id = ?').run(status, nowIso(), id);
  }

  allUrls(): string[] {
    return (this.db.prepare('SELECT url FROM links').all() as { url: string }[]).map((r) => r.url);
  }

  hostKnown(host: string): boolean {
    return this.allUrls().some((u) => {
      try {
        return new URL(u).hostname === host;
      } catch {
        return false;
      }
    });
  }

  /** Aplica un plan de importación de marcadores. Devuelve cuántos enlaces y familias se crearon. */
  applyImport(plan: ImportPlan, opts: { excluded: string[]; skipDuplicates: boolean }): { links: number; families: number } {
    const excluded = new Set(opts.excluded);
    let createdLinks = 0;
    let createdFamilies = 0;
    transaction(this.db, () => {
      const ids = new Map<string, number>();
      const known = new Set(this.allUrls().map(duplicateKey));
      for (const g of plan.groups) {
        if (excluded.has(g.key) || (g.parentKey && excluded.has(g.parentKey))) continue;
        const links = g.links.filter((l) => !(opts.skipDuplicates && (l.duplicate || known.has(duplicateKey(l.url)))));
        const hasKids = plan.groups.some((c) => c.parentKey === g.key && !excluded.has(c.key));
        if (links.length === 0 && !hasKids) continue;
        let familyId = g.existingFamilyId;
        if (familyId === null || !this.db.prepare('SELECT 1 FROM families WHERE id = ?').get(familyId)) {
          const parentId = g.parentKey ? (ids.get(g.parentKey) ?? null) : null;
          familyId = this.createFamily({ name: g.name.slice(0, 80), parentId }).id;
          createdFamilies++;
        }
        ids.set(g.key, familyId);
        for (const l of links) {
          this.createLink({ familyId, title: l.title, url: l.url, note: l.note });
          known.add(duplicateKey(l.url));
          createdLinks++;
        }
      }
    });
    return { links: createdLinks, families: createdFamilies };
  }

  /** Copia de seguridad completa (sin sesiones, PIN ni caché de favicons). */
  exportJson(): object {
    const { families, links } = this.snapshot();
    return {
      app: 'WebHub',
      formato: 1,
      exportado: nowIso(),
      families: families.map(({ id, parentId, name, position, collapsed }) => ({ id, parentId, name, position, collapsed })),
      links: links.map(({ id, familyId, title, url, note, tags, favorite, position, clicks, lastClickAt, checkIgnored }) => ({
        id, familyId, title, url, note, tags, favorite, position, clicks, lastClickAt, checkIgnored,
      })),
    };
  }

  /** Restaura una copia: sustituye todas las familias y enlaces actuales. */
  importJson(data: unknown): { families: number; links: number } {
    const d = data as { app?: unknown; families?: unknown; links?: unknown };
    if (!d || d.app !== 'WebHub' || !Array.isArray(d.families) || !Array.isArray(d.links)) {
      throw new InputError('El archivo no es una copia de seguridad de WebHub.');
    }
    const families = d.families as Record<string, unknown>[];
    const links = d.links as Record<string, unknown>[];
    return transaction(this.db, () => {
      this.db.exec('DELETE FROM links; DELETE FROM families;');
      const map = new Map<unknown, number>();
      // Primero las familias raíz, luego las subfamilias.
      const sorted = [...families].sort((a, b) => (a.parentId == null ? 0 : 1) - (b.parentId == null ? 0 : 1) || Number(a.position) - Number(b.position));
      for (const f of sorted) {
        const parentId = f.parentId == null ? null : map.get(f.parentId);
        if (parentId === undefined) throw new InputError(`La familia «${String(f.name)}» apunta a un padre inexistente.`);
        map.set(f.id, this.createFamily({ name: f.name, parentId, collapsed: f.collapsed === true }).id);
      }
      const sortedLinks = [...links].sort((a, b) => Number(a.position) - Number(b.position));
      for (const l of sortedLinks) {
        const familyId = map.get(l.familyId);
        if (familyId === undefined) throw new InputError(`El enlace «${String(l.title)}» apunta a una familia inexistente.`);
        const created = this.createLink({ ...l, familyId });
        const clicks = Number(l.clicks);
        if (Number.isInteger(clicks) && clicks > 0) {
          this.db.prepare('UPDATE links SET clicks = ?, last_click_at = ? WHERE id = ?').run(
            clicks,
            typeof l.lastClickAt === 'string' ? l.lastClickAt : null,
            created.id,
          );
        }
        if (l.checkIgnored === true) {
          this.db.prepare('UPDATE links SET check_ignored = 1 WHERE id = ?').run(created.id);
        }
      }
      return { families: families.length, links: links.length };
    });
  }
}
