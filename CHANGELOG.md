# Changelog

Todos los cambios relevantes de WebHub se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [0.6.0] - 2026-10-15

### Añadido

- Analizador de páginas: en el diálogo de crear o editar un enlace hay un botón
  «Analizar página»; en un enlace nuevo se analiza solo al salir del campo URL. El
  servidor descarga la página y propone título (solo rellena el campo Título si
  está vacío; nunca pisa uno escrito), descripción (botón «Usar la descripción como
  nota»; no se rellena sola) y etiquetas sugeridas como botones que se añaden o
  quitan del campo de etiquetas con un clic (siempre se puede guardar aunque falle
  el análisis). Todo con reglas locales, sin inteligencia artificial ni servicios
  externos: ningún enlace sale a un tercero.
- Propuesta de etiquetas, por orden: primero las etiquetas que el usuario ya usa en
  sus enlaces cuando coinciden (sin distinguir mayúsculas ni tildes, y con la
  grafía del usuario); después las palabras clave y etiquetas de artículo que
  declara la página (máximo 5); reglas por dominio (GitHub y GitLab → git y
  código; YouTube → vídeo; subdominios docs., wiki., panel., status., api.,
  mail. → documentación, wiki, panel, monitor, api, correo); el tipo de página
  (vídeo, artículo); y hasta 3 palabras frecuentes del título y la descripción.
  Máximo 8, sin duplicados.
- Lectura de la página: tope de 256 KB (solo se miran los primeros 128 KB y hasta
  `</head>`), 8 segundos de espera, codificaciones utf-8, iso-8859-1 y
  windows-1252, decodificación de entidades HTML y sin metadatos falsos dentro de
  scripts, estilos o comentarios.
- Ruta `POST /api/links/analizar` (exige sesión), con límite de 20 análisis por
  minuto en total (429 con `Retry-After`); no se registra la URL analizada.
  Errores claros: dirección interna (422), la dirección no devuelve una página web
  (422), tiempo agotado (504), no se pudo descargar (502), URL no válida (400).

### Cambiado

- El dominio real ya no está en el repositorio: `docker-compose.yml` lee
  `WEBHUB_PUBLIC_ORIGIN` del archivo `.env` (no versionado, ya estaba en
  `.gitignore`), con `.env.ejemplo` como plantilla; si falta, `docker compose`
  falla con un mensaje claro; la guía de despliegue usa un dominio de ejemplo
  (`webhub.ejemplo.com` / `TU-DOMINIO`). Actualizar instalaciones existentes: crear
  `.env` con `WEBHUB_PUBLIC_ORIGIN=https://tu-dominio` antes de `docker compose up`.
- En el comprobador, un enlace a una red interna aparece como
  «bloqueado (red interna)», dentro de «A revisar»; se puede marcar «Está bien».

### Seguridad

- Protección contra peticiones a redes internas: el comprobador de enlaces, la
  descarga de favicons y el analizador hacen peticiones salientes desde el
  servidor y antes no tenían restricción (con sesión se podía hacer que el servidor
  consultara servicios internos del VPS). Ahora no pueden alcanzar direcciones
  internas: loopback (127.x, ::1), redes privadas (10.x, 172.16–31.x incluido el
  host de Docker, 192.168.x), enlace local y metadatos de nube (169.254.x),
  100.64/10, rangos reservados y multicast, direcciones IPv6 locales y las que
  llevan una IPv4 incrustada (IPv4 mapeada, NAT64, 6to4, Teredo). La IP se valida
  en el momento de conectar (no antes; un dominio que cambie de IP no sirve) y se
  comprueba cada salto de redirección (máximo 5); solo http y https; se bloquean
  las formas disfrazadas (IP en decimal, hexadecimal, corchetes).

## [0.5.2] - 2026-10-15

### Añadido

- Capturas de pantalla en el README (`docs/img/`), hechas con datos de ejemplo inventados: ningún enlace real.

### Corregido

- En Administrar › Aspecto, los selectores de color («Color de acento» y color de los títulos) ocupaban toda la fila; ahora tienen un tamaño normal.

## [0.5.1] - 2026-10-15

### Seguridad

- Cabecera `X-Robots-Tag` (noindex, nofollow, noarchive, nosnippet, noimageindex)
  en todas las respuestas y archivo `robots.txt` que prohíbe el rastreo, para que
  la aplicación no aparezca en buscadores (antes solo había una etiqueta meta en
  la página de entrada).

## [0.5.0] - 2026-10-15

### Añadido

- Registro de accesos: la base de datos guarda un registro de entradas
  (migración 4, tabla `access_log`): entrada con PIN, entrada con huella,
  PIN incorrecto, huella no válida, bloqueo de entrada, huella añadida y
  borrada, PIN desactivado y reactivado. De cada evento se guarda fecha,
  tipo, resultado, IP y una etiqueta corta del dispositivo (por ejemplo
  «Chrome en Windows», nunca el texto del navegador) y el nombre de la
  huella cuando procede; nunca se guarda el PIN ni cuerpos de peticiones.
  Se ve en Administrar › Acceso, con resumen del último acceso correcto y
  de los intentos fallidos de las últimas 24 horas. Al entrar, si hubo
  intentos fallidos desde la entrada anterior, sale un aviso superior con
  «Ver registro». Rutas `GET /api/accesos` y `GET /api/accesos/resumen`
  (exigen sesión).

- Modo «solo huella»: en Administrar › Acceso se puede desactivar la
  entrada con PIN (solo si hay al menos una huella registrada), de modo
  que no hay nada que adivinar. La recuperación es ejecutar
  `npm run pin` en el servidor (con Docker
  `docker compose run --rm webhub npm run pin`), que cambia el PIN y
  reactiva la entrada por PIN. `GET /api/session` devuelve además `pin`.
  Ruta `PUT /api/acceso/pin`.

- Comprobador de enlaces (Administrar › Enlaces rotos): ahora clasifica en
  bien, protegidos (HTTP 401 y 403: la página responde pero pide sesión o
  bloquea las comprobaciones automáticas; no está rota), posibles privados
  (HTTP 404 o 410 en github.com o www.github.com, porque GitHub responde
  404 a un repositorio privado sin sesión), a revisar (429, errores 5xx y
  tiempo agotado), rotos (el resto) e ignorados. Botón «Está bien» por
  enlace para dejar de vigilarlo, «Volver a vigilar» y «Está bien (todos)»
  en privados y protegidos; las secciones de privados, protegidos e
  ignorados van plegadas. Migración 5 (marca por enlace, también incluida
  en la copia de seguridad JSON; el formato sigue siendo 1).

- Columnas explícitas: en la vista «Todos» cada familia principal con sus
  subfamilias forma un grupo que se arrastra desde el título de cualquiera
  de sus bloques a cualquier columna y posición (también al final de una
  columna o a una columna vacía). La columna queda guardada en el servidor
  (migración 6, campo por familia principal; también en la copia de
  seguridad JSON). Ruta `PUT /api/families/layout`. En pantallas táctiles no
  se puede arrastrar. Las familias que aún no se han colocado se reparten
  solas en la columna con menos carga.

### Cambiado

- Plegar o desplegar un bloque ya NO mueve ningún bloque de columna: antes
  el navegador repartía las columnas para equilibrarlas.
- El comprobador deja de contar como rotos los enlaces protegidos y los
  404 de GitHub (ahora «posibles privados»), porque en realidad funcionan.
- Migraciones 4, 5 y 6 de la base de datos, aplicadas solas al arrancar;
  cambios de esquema compatibles.
- `GET /api/session` devuelve además `pin`.
- El reparto automático de familias nuevas ya no equilibra según la altura
  sino según el número de enlaces.

### Seguridad

- Protecciones del registro de accesos: tras 30 eventos fallidos en una
  hora se descartan los siguientes fallos (se cuenta cuántos se omiten y
  se avisa); los eventos correctos y los de bloqueo, altas y bajas de
  huellas nunca se descartan; máximo 1000 eventos y 180 días, y la purga
  nunca borra los 100 eventos correctos más recientes. Las peticiones
  rechazadas por estar bloqueado no se registran una a una. Si falla el
  registro nunca impide entrar.
- Modo solo huella: con el PIN desactivado el servidor rechaza cualquier
  PIN con 403 sin calcular el hash y sin contar como fallo.
- No se puede borrar la última huella mientras el PIN esté desactivado.

## [0.4.0] - 2026-10-15

### Añadido

- Familias plegadas por defecto: casilla «Mostrar sus enlaces plegados por defecto» en el diálogo
  de crear o editar una familia o subfamilia. Esa familia aparece con sus enlaces ocultos (solo
  título y contador) en «Todos» y en su vista, y se despliega con la flecha ▾. Lo que cada
  persona pliega o despliega a mano se recuerda en ese navegador y prevalece sobre la marca. La
  marca se guarda en el servidor, forma parte de la copia de seguridad JSON (las copias antiguas
  sin el campo se restauran como no plegadas; el formato sigue siendo 1) y la base de datos añade
  una columna (migración 3, automática al arrancar).
- Pestaña «Aspecto» en Administrar con vista previa al instante: tema (Oscuro, Alto contraste,
  Claro); tamaño del texto de toda la aplicación (80 % a 200 %); fuente (Sistema, Verdana,
  Humanista, Con serifa, Monoespaciada; fuentes del sistema, sin descargas); densidad de las filas
  (Compacta, Normal, Cómoda); títulos de familia (tamaño del 100 % al 220 %, peso
  Normal/Seminegrita/Negrita/Extranegrita, mayúsculas sí o no y color propio); color de acento;
  mostrar u ocultar el dominio junto a cada enlace; fondo del área central (Liso, Cuadrícula,
  Puntos, Resplandor, Aurora, con color e intensidad) y «Restablecer todo». Pensado para quien
  necesita letra más grande o más contraste.
- Rutas `GET` y `PUT /api/aspecto`, que exigen sesión. El aspecto se guarda en el servidor
  (ajuste `aspecto` en la base de datos) y vale igual en todos los dispositivos.

### Cambiado

- El fondo del área central, que en la 0.2.0 se guardaba en cada navegador, ahora se guarda en el
  servidor: hay que volver a elegirlo una vez.
- Los títulos de familia son por defecto algo más grandes (120 %) y en negrita.
- Todas las medidas de la hoja de estilos pasan de píxeles a rem, para que el tamaño del texto
  escale con todo (a 100 % el aspecto es idéntico al anterior).
- El título y el contador de la barra superior ya no se encogen con textos grandes.
- Los temas y colores usan `color-mix()` de CSS, por lo que requieren un navegador de 2023 en
  adelante (Chrome o Edge 111, Firefox 113, Safari 16.2).
- Migración 3 de la base de datos, aplicada sola al arrancar; cambio de esquema compatible.

### Seguridad

- Validación estricta del aspecto en el servidor: listas cerradas, números acotados y colores
  `#rrggbb`; solo se guarda lo saneado.

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
