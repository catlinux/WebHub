# Despliegue en el VPS (Docker + Apache + Certbot)

Guía para instalar WebHub en un VPS Linux con Docker, detrás de Apache sirviendo HTTPS con Certbot.
Es la instalación real de `webhub.invierteconcriterio.es`: código en `/opt/contabo-apps/webhub`,
usuario `sysmarc` (uid 1001), Debian 13. Al final hay alternativas sin Docker (systemd) y con Caddy.

## Por qué Docker

WebHub necesita Node 22.18 o superior y el Node de la distribución puede ser más antiguo y estar en uso
por otras aplicaciones (en este VPS, Debian trae Node 20 y su `npm`). Sustituirlo podría romperlas.
El contenedor `node:22-alpine` lleva su propio Node y no toca el del sistema.

No hay imagen propia: WebHub no tiene dependencias de ejecución, así que se usa la imagen oficial con el código
montado de solo lectura. Solo `data/` es escribible.

## 1. Código y datos

```sh
sudo mkdir -p /opt/contabo-apps/webhub
sudo chown sysmarc:sysmarc /opt/contabo-apps/webhub

# Como sysmarc (con el repo privado hace falta una clave SSH con acceso):
git clone git@github.com:catlinux/WebHub.git /opt/contabo-apps/webhub
cd /opt/contabo-apps/webhub
mkdir -p data && chmod 700 data
```

La base de datos va en `data/webhub.sqlite` (está en `.gitignore`, así que `git pull` no la toca).

## 2. Configuración

Revisa [docker-compose.yml](../docker-compose.yml):

- `user`: uid:gid del dueño del directorio (`id -u`, `id -g`); así los archivos de `data/` son suyos.
- `WEBHUB_PUBLIC_ORIGIN`: tu dominio con `https://`.
- El puerto se publica solo en `127.0.0.1:3000`. Si está ocupado (`ss -ltnp`), cambia el de la izquierda.
- `WEBHUB_TRUST_PROXY=1`: el límite de intentos usa la última IP de `X-Forwarded-For`, la que añade Apache.
  Si delante de Apache hubiera otro proxy (p. ej. Cloudflare), esa IP sería la del proxy: habría que
  configurar `mod_remoteip`. En este VPS el DNS apunta directamente al servidor.

## 3. Compilar, PIN y arranque

```sh
cd /opt/contabo-apps/webhub
docker compose run --rm build          # npm ci + public/app.js, dentro de un contenedor
docker compose run --rm webhub npm run pin
docker compose up -d
docker compose ps
curl -s http://127.0.0.1:3000/api/session   # {"authenticated":false,"configured":true}
```

El PIN se pide dos veces sin mostrarlo (de 6 a 12 dígitos; cuantos más, mejor). Solo se guarda su hash scrypt.
Para cambiarlo se repite el mismo comando (cierra todas las sesiones).

El contenedor tiene `restart: unless-stopped`: vuelve solo tras un reinicio si Docker está habilitado
(`systemctl is-enabled docker`). Los registros se ven con `docker compose logs webhub` y rotan (3 × 10 MB).

Si alguien intenta adivinar el PIN, el acceso se bloquea para todos de forma escalonada (de 15 min a 24 h).
Si te bloquea a ti, `docker compose restart webhub` lo desbloquea (el contador está en memoria).

## 4. Apache

Hacen falta los módulos `proxy`, `proxy_http`, `headers`, `ssl` y `rewrite`
(`sudo a2enmod proxy proxy_http headers ssl rewrite`). El vhost de partida es
[apache.conf.ejemplo](apache.conf.ejemplo):

```sh
sed 's/webhub\.ejemplo\.com/webhub.invierteconcriterio.es/g' docs/apache.conf.ejemplo \
  | sudo tee /etc/apache2/sites-available/webhub.invierteconcriterio.es.conf
sudo a2ensite webhub.invierteconcriterio.es.conf
sudo apache2ctl configtest      # recargar solo si da «Syntax OK»
sudo systemctl reload apache2
```

`ProxyPreserveHost On` y `X-Forwarded-Proto` son necesarios. WebHub ya envía CSP, `X-Frame-Options` y el resto
de cabeceras; Apache solo añade HSTS.

## 5. HTTPS con Certbot

```sh
sudo certbot --apache -d webhub.invierteconcriterio.es --redirect
sudo certbot renew --dry-run
```

Certbot crea el vhost `:443` (`…-le-ssl.conf`) a partir del anterior y redirige HTTP a HTTPS.
La renovación la hace el temporizador `certbot.timer`.

Comprobación:

```sh
curl -I https://webhub.invierteconcriterio.es   # 200, Strict-Transport-Security, Content-Security-Policy…
```

## 6. Copias de seguridad

- **Desde la web**: Administrar › Copia de seguridad › Descargar copia (JSON). Incluye familias, enlaces,
  notas, etiquetas, favoritos y contadores; no incluye el PIN ni las sesiones.
- **En el servidor**: la base de datos está en `/opt/contabo-apps/webhub/data/webhub.sqlite` (modo WAL). No la
  copies con `cp` en caliente; usa la copia en línea de SQLite, por ejemplo desde el propio contenedor:

```sh
docker compose exec webhub node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('/app/data/webhub.sqlite').exec(\"VACUUM INTO '/app/data/copia.sqlite'\")"
```

## 7. Actualizar

```sh
cd /opt/contabo-apps/webhub   # como sysmarc
git pull
docker compose run --rm build
docker compose restart webhub
```

Las migraciones de la base de datos se aplican solas al arrancar. Para usar un Node más nuevo:
`docker compose pull && docker compose up -d`.

## Salida a Internet del servidor

Los favicons y el comprobador de enlaces rotos hacen peticiones desde el VPS a las webs enlazadas
(los favicons se guardan en caché en la base de datos). Si el VPS no tiene salida o la filtra, verás
iniciales en lugar de favicons y el comprobador avisará de que casi todo falla por red.

## Alternativas

### Sin Docker (systemd)

Con Node 22.18 o superior en el sistema: `npm ci && npm run build`, crear el PIN con
`WEBHUB_DATA_DIR=/opt/contabo-apps/webhub/data npm run pin` y usar [webhub.service](webhub.service)
(ajusta `ExecStart` a `which node` y `WEBHUB_PUBLIC_ORIGIN`; si Node está en `/home` por nvm,
`ProtectHome=read-only`):

```sh
sudo cp docs/webhub.service /etc/systemd/system/webhub.service
sudo systemctl daemon-reload
sudo systemctl enable --now webhub
```

### Caddy en lugar de Apache

Añade el bloque de [Caddyfile.ejemplo](Caddyfile.ejemplo) con tu dominio, `sudo caddy validate --config
/etc/caddy/Caddyfile` y `sudo systemctl reload caddy`. Caddy obtiene el certificado solo.

## Qué se ha probado y qué no

**Probado en el VPS real** (Debian 13, Docker, Apache 2.4.68, `node:22-alpine` con Node 22.23.3, 2026-10-15):

- `npm test` (46 tests) y `npm run typecheck` en verde.
- Compilación del cliente dentro del contenedor (`docker compose run --rm build`).
- Contenedor en marcha, escuchando solo en `127.0.0.1:3000`; `/api/session` responde `configured:true` tras crear el PIN.
- `npm run pin` en una terminal interactiva real, dentro del contenedor.
- Apache como proxy inverso y certificado de Let's Encrypt con Certbot; HTTP redirige a HTTPS (301).
- `curl -I https://…`: 200 con HSTS, CSP, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`.
- PIN incorrecto → 401; petición con `Origin` ajeno → 403; el PIN no aparece en los registros.
- Entrada con el PIN desde el navegador del ordenador, a través de HTTPS (cookie `Secure`).
- Copia en línea con `VACUUM INTO` desde el contenedor.
- Docker habilitado al arranque y contenedor con `restart: unless-stopped`.

**Probado antes, en un contenedor de desarrollo:** interfaz en Chromium (Playwright) en escritorio y móvil
emulado, importador con archivos de ejemplo, comprobador contra un servidor local. La 0.2.0 se
comprobó en este VPS con Chromium real, en una instancia aparte con datos temporales: plegar bloques y recordarlo al recargar, tooltip, arrastrar
bloques (sin mezclar niveles), cambio de fondo y recuerdo del aspecto; no se ha probado en móvil físico ni
en Firefox/Safari.

**No probado:**

- Un reinicio real del VPS.
- Entrada desde el móvil (pendiente de confirmar).
- Que el límite de intentos vea la IP real del cliente a través de Apache y Docker (debería: la última IP de
  `X-Forwarded-For` es la que añade Apache).
- `certbot renew --dry-run` desde esta guía (lo ejecuta el administrador con sudo).
- Si la copia Borg del servidor incluye `/opt/contabo-apps/webhub/data`.
- La guía alternativa con systemd y la de Caddy.
- Exportaciones reales de tu navegador, Firefox y Safari.
