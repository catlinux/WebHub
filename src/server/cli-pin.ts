/**
 * Crea o cambia el PIN de acceso. Se pide por terminal sin eco.
 * Uso: npm run pin
 * Cambiarla cierra todas las sesiones abiertas.
 */
import { config } from './config.ts';
import { openDatabase } from './db.ts';
import { setPin, PIN_MIN, PIN_MAX } from './auth.ts';

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      // Permite: printf '%s\n' "$PIN" | npm run pin (útil en scripts).
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => (buf += d));
      stdin.on('end', () => resolve(buf.split('\n')[0] ?? ''));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const db = openDatabase(config.dataDir);
const first = await ask(`Nuevo PIN (${PIN_MIN} a ${PIN_MAX} dígitos): `);
const second = process.stdin.isTTY ? await ask('Repítelo: ') : first;
if (first !== second) {
  console.error('No coinciden. No se ha cambiado nada.');
  process.exit(1);
}
try {
  await setPin(db, first.trim());
  console.log(`PIN guardado en ${config.dataDir}. Se han cerrado todas las sesiones.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
db.close();
