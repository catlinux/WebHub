# Changelog

Todos los cambios relevantes de WebHub se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [0.3.0] - 2026-10-15

### Añadido

- Entrada con huella mediante passkeys (WebAuthn): huella, cara o Windows Hello del dispositivo.
  La huella no sale del dispositivo; el servidor solo guarda la clave pública (más id de
  credencial, algoritmo, contador, nombre y fechas). Sin dependencias nuevas (APIs del
  navegador y `node:crypto`). Algoritmos ES256, RS256 y EdDSA. El PIN se mantiene como
  alternativa y para dar de alta cada dispositivo.
- Botón «Entrar con huella» (con separador «o con el PIN») en la pantalla de entrada
  cuando el servidor tiene huellas y el dispositivo las admite; en móvil, si el dispositivo
  ya la tiene activada (marca en `localStorage`), se lanza sola al abrir y, si el navegador
  lo impide, queda el botón.
- Aviso «¿Entrar con huella en este dispositivo?» con «Activar» y «Ahora no» (se recuerda
  el «Ahora no») tras entrar con PIN en un dispositivo compatible sin huella.
- Pestaña nueva «Acceso» en Administrar: lista de dispositivos (nombre, alta, último uso),
  borrado con confirmación, activación en este dispositivo con nombre editable y nota de
  cómo cambiar el PIN.
- Rutas públicas `/api/webauthn/login-options` y `/api/webauthn/login`; rutas de gestión
  `/api/webauthn/register-options`, `/register`, `/credentials` (GET y DELETE `/:id`).
  Máximo 10 huellas.

### Cambiado

- `GET /api/session` devuelve además `passkeys` (booleano).
- Tabla `passkeys` (migración 2 de la base de datos), aplicada sola al arrancar; cambio de
  esquema compatible.

### Seguridad

- Reto aleatorio de un solo uso que caduca a los 2 minutos, guardado en memoria en almacenes
  separados para registro y entrada; se comprueban tipo, reto, origin, hash del rpId, presencia
  (UP) y verificación de usuario (UV) obligatorias, firma y contador (si retrocede se rechaza
  por posible clon); mensajes de error genéricos hacia el cliente.
- Las huellas no pasan por el bloqueo escalonado del PIN (no se pueden adivinar), por lo que
  bloquear el PIN no impide entrar con la huella.
- La exportación JSON no incluye las huellas; las huellas quedan atadas al dominio
  (rpId = host de `WEBHUB_PUBLIC_ORIGIN`).

## [0.2.0] - 2026-10-15

### Añadido

- Reordenar los bloques de familia en las vistas «Todos» y de familia arrastrando
  desde su título, solo entre familias del mismo nivel (familias entre sí,
  subfamilias entre las de la misma familia); se guarda en el servidor con la
  ruta de orden ya existente. En pantallas táctiles no arrastra y se reordena con
  los botones ↑↓ de Administrar › Organizar.
- Flecha ▾ a la izquierda del título de cada bloque para plegarlo u ocultar su
  contenido; el contador sigue visible; el estado plegado se recuerda en el
  navegador (`localStorage`), por dispositivo.
- Tooltip propio con estilo (título, URL en tipografía monoespaciada, nota,
  etiquetas y número de veces abierto) en lugar del tooltip nativo del navegador;
  no aparece en pantallas táctiles.
- Pestaña nueva «Aspecto» en Administrar: fondo discreto del área central
  configurable (Liso, Cuadrícula, Puntos —el predeterminado—, Resplandor,
  Aurora), color e intensidad, con vista previa al instante y botón Restablecer;
  se guarda en el navegador, por dispositivo, no en el servidor. Nuevo
  `src/shared/aspecto.ts` con su test (4 tests).

## [0.1.1] - 2026-10-15

### Añadido

- `docker-compose.yml`: WebHub en `node:22-alpine` con el código de solo lectura, `data/` montado, puerto solo en
  `127.0.0.1`, reinicio automático, rotación de registros y un servicio `build` para compilar el cliente.
- `docs/apache.conf.ejemplo`: vhost de Apache como proxy inverso con HSTS, para usar con Certbot.

### Cambiado

- La guía de despliegue pasa a Docker + Apache + Certbot, con lo comprobado en el VPS real; systemd y Caddy
  quedan como alternativas.
- `.gitignore` excluye los archivos locales de herramientas y del editor.

## [0.1.0] - 2026-10-15

Primera versión.

### Añadido

- Familias y subfamilias (dos niveles) en una barra lateral con contadores.
- Listas densas en columnas: favicon, título, dominio y nota; todos los enlaces se abren en una pestaña nueva.
- Vistas «Todos» y «Favoritos y más usados» con contador de clics en el servidor.
- Búsqueda instantánea por título, dominio, URL, notas, etiquetas y familia, sin distinguir tildes.
- Atajos de teclado: `Ctrl+K` o `/`, flechas o `j`/`k`, `Enter`, `f` y `Esc`.
- Diseño adaptable a móvil (vertical y horizontal) y tablet: barra lateral plegable, panel de administración
  en una columna, tabla del comprobador apilada, botones táctiles más grandes y campos sin zoom en iOS.
- Entrada con PIN de 6 a 12 dígitos, sin usuario ni contraseña (hash scrypt), cookie `HttpOnly` + `Secure` +
  `SameSite=Strict`, límite de intentos por IP, bloqueo global escalonado (15 min → 24 h) y protección CSRF.
- Panel de administración: crear, editar, borrar, reordenar (arrastrando o con botones) y mover familias y enlaces;
  etiquetas, notas y favoritos.
- Importación de marcadores HTML (Chrome, Edge, Firefox) con vista previa, selección de carpetas y detección de duplicados.
- Exportación y restauración completa en JSON.
- Comprobador de enlaces rotos bajo demanda.
- Favicons descargados por el servidor y guardados en caché.
- Guía de despliegue con Caddy y systemd.
