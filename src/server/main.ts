import { config } from './config.ts';
import { openDatabase } from './db.ts';
import { createApp } from './app.ts';
import { getPinHash } from './auth.ts';
import { ProgramadorCopias } from './copias.ts';

const db = openDatabase(config.dataDir);

let programador: ProgramadorCopias | null = null;
if (config.backupEnabled) {
  programador = new ProgramadorCopias(db, config.backupDir, { conservar: config.backupKeep, primerAvisoMs: config.backupFirstDelayMs });
}

const { server } = createApp({
  db,
  insecureCookie: config.insecureCookie,
  trustProxy: config.trustProxy,
  publicOrigin: config.publicOrigin,
  sessionDays: config.sessionDays,
  copiasDir: config.backupEnabled ? config.backupDir : null,
  copiasConservar: config.backupKeep,
});

server.listen(config.port, config.host, () => {
  console.log(`WebHub escuchando en http://${config.host}:${config.port} (datos en ${config.dataDir})`);
  if (!getPinHash(db)) console.log('Aviso: aún no hay PIN. Créalo con «npm run pin».');
  if (config.backupEnabled && programador) {
    programador.iniciar();
    console.log(`Copia automática diaria en ${config.backupDir} (conserva ${config.backupKeep}).`);
  } else {
    console.log('Copia automática desactivada.');
  }
});

const stop = () => {
  programador?.detener();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);