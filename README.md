# WebHub

<img src="public/icon-192.png" alt="" width="96" align="right">

Directorio personal de enlaces de **CatLinux**: todos los servicios, redes, webs propias y webs de interés
ordenados por familias, localizables al instante y en una sola pestaña ligera en lugar de 40 abiertas.

Uso personal, un solo usuario. Toda la aplicación (también la lista de enlaces) exige iniciar sesión.

## Funciones

- **Familias y subfamilias** en una barra lateral fija con el número de enlaces de cada una.
- **Listas densas**, una línea por enlace: favicon, título, dominio en gris y nota opcional, en columnas
  para ver muchos enlaces sin desplazarse. Sin tarjetas.
- **Todos los enlaces se abren siempre en una pestaña nueva** (`target="_blank" rel="noopener noreferrer"`).
- **Búsqueda instantánea** por título, dominio, URL, notas, etiquetas y familia, sin distinguir tildes.
- Vistas **Todos** y **Favoritos y más usados** (contador de clics guardado en tu propio servidor).
- **Teclado**: `Ctrl+K` o `/` para buscar, `↓`/`↑` (o `j`/`k`) para moverse, `Enter` para abrir,
  `f` para marcar favorito, `Esc` para volver al buscador.
- **Móvil**: la barra lateral se pliega.
- **Panel de administración**:
  - crear, editar, borrar y reordenar (arrastrando o con ↑↓) familias y enlaces; mover enlaces entre familias;
  - importar marcadores del navegador (HTML de Chrome, Edge, Firefox…) con vista previa y detección de duplicados;
  - exportar y restaurar todo en JSON;
  - comprobador de enlaces rotos bajo demanda.

WebHub **no guarda contraseñas ni secretos** de ningún tipo (ver [TODO.md](TODO.md)).

## Requisitos

- Node.js **22.18 o superior** (ejecuta TypeScript directamente y trae SQLite integrado).
- Nada más en producción: cero dependencias de ejecución. `esbuild`, `typescript` y `@types/node` solo se usan para compilar.

## Puesta en marcha (local)

```sh
npm ci
npm run build                  # genera public/app.js
npm run password               # crea la contraseña (mínimo 12 caracteres)
WEBHUB_INSECURE_COOKIE=1 npm start   # http://127.0.0.1:3000
```

`WEBHUB_INSECURE_COOKIE=1` solo es para probar por `http://` en local. En producción, detrás de HTTPS, no se usa.

Para el servidor (VPS con Caddy) sigue [docs/despliegue.md](docs/despliegue.md).

## Configuración

Por variables de entorno:

| Variable | Por defecto | Uso |
|---|---|---|
| `WEBHUB_HOST` | `127.0.0.1` | Interfaz de escucha. Déjalo en local y pon Caddy delante. |
| `WEBHUB_PORT` | `3000` | Puerto. |
| `WEBHUB_DATA_DIR` | `./data` | Carpeta de la base de datos SQLite. |
| `WEBHUB_TRUST_PROXY` | (vacío) | `1` detrás de Caddy: usa la IP de `X-Forwarded-For` para el límite de intentos. |
| `WEBHUB_PUBLIC_ORIGIN` | (vacío) | p. ej. `https://webhub.ejemplo.com`. Si se define, las peticiones de escritura deben venir de ese origen. |
| `WEBHUB_SESSION_DAYS` | `30` | Duración de la sesión. |
| `WEBHUB_INSECURE_COOKIE` | (vacío) | `1` quita el atributo `Secure` de la cookie (solo desarrollo). |

## Seguridad

- Contraseña única guardada como hash **scrypt** con sal; se crea o cambia por terminal (`npm run password`),
  y cambiarla cierra todas las sesiones.
- Sesión por cookie `HttpOnly`, `Secure` y `SameSite=Strict`; en la base de datos solo se guarda el hash del token.
- Límite de intentos de login: 5 fallos por IP en 15 minutos y 30 en total (frena ataques repartidos).
- Protección CSRF: cabecera propia obligatoria en las escrituras y comprobación de `Origin`.
- Solo se admiten URLs `http`/`https` (nunca `javascript:` ni `data:`), también al importar.
- CSP estricta (`script-src 'self'`), sin `innerHTML` con datos del usuario, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`.
- Los registros nunca incluyen cuerpos de petición, cabeceras ni la cookie.

## Desarrollo

```sh
npm test          # tests de lógica: importador, orden, búsqueda, URLs, autenticación y API
npm run typecheck
npm run dev       # compila el cliente y reinicia el servidor al cambiar el código
test/e2e/ejecutar.sh   # prueba en Chromium real con capturas (requiere Playwright instalado aparte)
```

Estructura:

```
src/shared/   lógica común probada con tests (URLs, búsqueda, orden, marcadores)
src/server/   servidor HTTP (node:http), SQLite (node:sqlite), autenticación, API
src/client/   interfaz sin framework, empaquetada con esbuild en public/app.js
public/       HTML, CSS, logo y favicons
test/         tests (node:test) y prueba e2e
docs/         guía de despliegue y ejemplos de Caddy y systemd
```

El logo y los favicons salen de `assets/icono.png` con `python3 scripts/generar-favicons.py` (requiere Pillow).

## Créditos

Creado y mantenido por **CatLinux**.

Sin licencia por ahora: todos los derechos reservados.
