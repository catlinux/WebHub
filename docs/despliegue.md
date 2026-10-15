# Despliegue en el VPS (Caddy + systemd)

Guía para instalar WebHub en un VPS Linux con Caddy delante sirviendo HTTPS.

> **Estado de la verificación.** Esta guía **no se ha probado en un VPS real**: se escribió y comprobó
> parcialmente en un contenedor de desarrollo. Al final está el detalle de qué se ha probado y qué no.
> Revísala paso a paso la primera vez.

## 1. Node.js

Hace falta **Node 22.18 o superior** (TypeScript sin compilar y `node:sqlite` integrado).

```sh
node --version   # v22.18.0 o mayor
```

Si la distribución trae una versión anterior, instala Node 22 LTS desde NodeSource o con el gestor que uses.
Si cambias `node` de ruta, ajusta `ExecStart` en el servicio.

## 2. Código y datos

WebHub se instala en `/opt/contabo-apps/webhub` y se ejecuta con el usuario `sysmarc`.
La base de datos va en `/opt/contabo-apps/webhub/data` (está en `.gitignore`, así que `git pull` no la toca).

```sh
sudo mkdir -p /opt/contabo-apps/webhub
sudo chown sysmarc:sysmarc /opt/contabo-apps/webhub

# Como sysmarc:
git clone https://github.com/catlinux/WebHub.git /opt/contabo-apps/webhub
# (con el repo privado: git clone git@github.com:catlinux/WebHub.git /opt/contabo-apps/webhub)
cd /opt/contabo-apps/webhub
mkdir -p data && chmod 700 data
npm ci
npm run build
```

## 3. PIN

```sh
cd /opt/contabo-apps/webhub
WEBHUB_DATA_DIR=/opt/contabo-apps/webhub/data npm run pin   # como sysmarc
```

Pide el PIN dos veces sin mostrarlo (de 6 a 12 dígitos; cuantos más, mejor). Solo se guarda su hash scrypt.
Para cambiarlo más adelante se repite el mismo comando (cierra todas las sesiones).

Si alguien intenta adivinar el PIN, el acceso se bloquea para todos de forma escalonada (de 15 min a 24 h) y en
`journalctl -u webhub` aparece «Login bloqueado N min…». Si te bloquea a ti, `sudo systemctl restart webhub` lo
desbloquea (el contador está en memoria).

## 4. Servicio systemd

Copia [webhub.service](webhub.service), cambia `WEBHUB_PUBLIC_ORIGIN` por tu dominio y actívalo.
Comprueba la ruta de Node con `which node`: si no es `/usr/bin/node`, ajusta `ExecStart`
(y si está en `/home/sysmarc` por nvm, pon `ProtectHome=read-only`).

```sh
sudo cp docs/webhub.service /etc/systemd/system/webhub.service
sudo nano /etc/systemd/system/webhub.service
sudo systemctl daemon-reload
sudo systemctl enable --now webhub
systemctl status webhub
curl -s http://127.0.0.1:3000/api/session   # {"authenticated":false,"configured":true}
```

## 5. Caddy

Añade el bloque de [Caddyfile.ejemplo](Caddyfile.ejemplo) con tu dominio y recarga:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtiene el certificado y redirige HTTP a HTTPS. WebHub escucha solo en `127.0.0.1`, así que
únicamente es accesible a través de Caddy. Con `WEBHUB_TRUST_PROXY=1` el límite de intentos usa la IP real
(la última de `X-Forwarded-For`, que es la que añade Caddy). **No actives esa variable si WebHub queda
expuesto sin Caddy**, porque cualquiera podría falsear la cabecera.

Capa extra opcional: restringir el acceso por IP o VPN en Caddy (comentado en el ejemplo).

## 6. Copias de seguridad

Dos opciones complementarias:

- **Desde la web**: Administrar › Copia de seguridad › Descargar copia (JSON). Incluye familias, enlaces,
  notas, etiquetas, favoritos y contadores; no incluye el PIN ni las sesiones.
- **En el servidor**: la base de datos está en `/opt/contabo-apps/webhub/data/webhub.sqlite` (modo WAL). No la copies
  con `cp` en caliente; usa la copia en línea de SQLite (requiere el paquete `sqlite3`):

```sh
sqlite3 /opt/contabo-apps/webhub/data/webhub.sqlite ".backup '/var/backups/webhub-$(date +%F).sqlite'"
```

## 7. Actualizar

```sh
cd /opt/contabo-apps/webhub   # como sysmarc
git pull
npm ci
npm run build
sudo systemctl restart webhub
```

Las migraciones de la base de datos se aplican solas al arrancar.

## Salida a Internet del servidor

Los favicons y el comprobador de enlaces rotos hacen peticiones desde el VPS a las webs enlazadas
(los favicons se guardan en caché en la base de datos para no repetirlas). Si el VPS no tiene salida
o la filtra, verás iniciales en lugar de favicons y el comprobador avisará de que casi todo falla por red.

## Qué se ha probado y qué no

**Probado** (contenedor Linux, Node 22.22.0):

- Tests automáticos (`npm test`): importador de marcadores (formato de Chrome y Firefox con archivos de ejemplo
  escritos a mano), orden, búsqueda, validación de URLs, hash del PIN, sesiones, límite de intentos y bloqueo escalonado
  y la API completa (login, CSRF, CRUD, reordenar, mover, importar, exportar/restaurar, borrado en cascada).
- Interfaz en **Chromium real** (Playwright) con capturas, en escritorio (1440×900) y móvil emulado (390×844):
  login, importación con vista previa, vistas, búsqueda con teclado, apertura en pestaña nueva, favoritos,
  arrastrar para reordenar y mover, formularios, copia de seguridad, comprobador y cierre de sesión.
- Comprobador de enlaces contra un servidor HTTP local (200, 404, HEAD no admitido, conexión rechazada).
- `npm run pin` sin terminal (por tubería).

**No probado:**

- Un VPS real, **Caddy** y el servicio **systemd** de esta guía (incluido el endurecimiento).
- HTTPS de extremo a extremo y la cookie `Secure` a través de Caddy (los tests solo verifican que se envía).
- `X-Forwarded-For` real de Caddy con `WEBHUB_TRUST_PROXY=1`.
- Favicons y comprobador contra webs reales de Internet: el contenedor bloquea casi todos los dominios externos
  (solo se cargaron algunos favicons, como el de GitHub).
- Exportaciones reales de tu navegador (solo archivos de ejemplo con el mismo formato).
- Firefox, Safari y dispositivos móviles físicos.
- `npm run pin` en una terminal interactiva real.
