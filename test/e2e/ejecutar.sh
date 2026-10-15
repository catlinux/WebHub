#!/bin/sh
# Arranca WebHub con datos temporales en el puerto 3100 y ejecuta la prueba en Chromium.
# Requiere Playwright (npm i -g playwright && npx playwright install chromium).
# Las capturas quedan en el directorio temporal que se muestra al final.
set -e
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
node scripts/build.ts >/dev/null 2>&1
printf '%s\n' 'demo-clave-larga-123' | WEBHUB_DATA_DIR="$TMP/data" node --disable-warning=ExperimentalWarning src/server/cli-password.ts >/dev/null
WEBHUB_DATA_DIR="$TMP/data" WEBHUB_INSECURE_COOKIE=1 WEBHUB_PORT=3100 node --disable-warning=ExperimentalWarning src/server/main.ts >"$TMP/servidor.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
sleep 1
NODE_PATH="${NODE_PATH:-$(npm root -g)}" node test/e2e/navegador.cjs "$TMP"
echo "Capturas en $TMP/capturas"
