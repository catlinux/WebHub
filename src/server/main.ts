import { config } from './config.ts';
import { openDatabase } from './db.ts';
import { createApp } from './app.ts';
import { getPinHash } from './auth.ts';

const db = openDatabase(config.dataDir);
const { server } = createApp({
  db,
  insecureCookie: config.insecureCookie,
  trustProxy: config.trustProxy,
  publicOrigin: config.publicOrigin,
  sessionDays: config.sessionDays,
});

server.listen(config.port, config.host, () => {
  console.log(`WebHub escuchando en http://${config.host}:${config.port} (datos en ${config.dataDir})`);
  if (!getPinHash(db)) console.log('Aviso: aún no hay PIN. Créalo con «npm run pin».');
});

const stop = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
