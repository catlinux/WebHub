import type { DatabaseSync } from 'node:sqlite';
import type { Aspecto } from '../shared/aspecto.ts';
import { parseAspecto } from '../shared/aspecto.ts';

export function getAspecto(db: DatabaseSync): Aspecto {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'aspecto'").get() as { value: string } | undefined;
  return parseAspecto(row?.value ?? null);
}

export function setAspecto(db: DatabaseSync, body: unknown): Aspecto {
  const saneado = parseAspecto(JSON.stringify(body));
  const json = JSON.stringify(saneado);
  db.prepare("INSERT INTO settings (key, value) VALUES ('aspecto', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(json);
  return saneado;
}