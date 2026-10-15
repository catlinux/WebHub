# Changelog

Todos los cambios relevantes de WebHub se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/)
y el proyecto usa [versionado semántico](https://semver.org/lang/es/).

## [0.1.0] - 2026-10-15

Primera versión.

### Añadido

- Familias y subfamilias (dos niveles) en una barra lateral con contadores.
- Listas densas en columnas: favicon, título, dominio y nota; todos los enlaces se abren en una pestaña nueva.
- Vistas «Todos» y «Favoritos y más usados» con contador de clics en el servidor.
- Búsqueda instantánea por título, dominio, URL, notas, etiquetas y familia, sin distinguir tildes.
- Atajos de teclado: `Ctrl+K` o `/`, flechas o `j`/`k`, `Enter`, `f` y `Esc`.
- Diseño adaptado a móvil con barra lateral plegable.
- Inicio de sesión con contraseña (scrypt), cookie `HttpOnly` + `Secure` + `SameSite=Strict`,
  límite de intentos por IP y global, y protección CSRF.
- Panel de administración: crear, editar, borrar, reordenar (arrastrando o con botones) y mover familias y enlaces;
  etiquetas, notas y favoritos.
- Importación de marcadores HTML (Chrome, Edge, Firefox) con vista previa, selección de carpetas y detección de duplicados.
- Exportación y restauración completa en JSON.
- Comprobador de enlaces rotos bajo demanda.
- Favicons descargados por el servidor y guardados en caché.
- Guía de despliegue con Caddy y systemd.
