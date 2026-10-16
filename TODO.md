# TODO

## Pendiente

- [ ] Confirmar que la copia diaria del servidor recoge data/copias/webhub-ultima.sqlite (lo configura
      otro proyecto) y probar una restauración completa; ver docs/copias.md.
- [ ] Comprobar la entrada con huella en un móvil real y en el dominio de producción, y anotar el
      resultado en docs/despliegue.md.
- [ ] Comprobar el aspecto configurable y las familias plegadas en un móvil real y en producción.
- [ ] Comprobar el registro de accesos, el modo solo huella, el comprobador y las columnas en un móvil real y en producción.
- [ ] Probar el analizador de páginas con webs reales y ajustar las reglas de etiquetas si hace falta.
- [ ] Comprobar la copia automática, el aviso de duplicados y los tamaños táctiles en un móvil real y en producción.
- [ ] Guardar las pruebas de navegador (extremo a extremo) en el repositorio y añadir una verificación automática en GitHub.
- [ ] Lista y cierre de sesiones desde la interfaz (hoy solo se cierran todas cambiando el PIN).

## Pendiente de decidir

- [ ] Dominio real en el repositorio público (docker-compose.yml y guía de despliegue). Decidido el
      2026-10-15: el repositorio sigue público; lo que nunca debe salir son los enlaces ni los datos del
      usuario (bases de datos, copias, capturas con datos reales). Opcional: sustituir el dominio real por
      uno de ejemplo.

- [ ] Campo «Referencia KeePassXC» por enlace (solo texto con la ruta de la entrada, p. ej. `Proveedores/OVH`,
      con botón de copiar). Nunca guardar secretos en WebHub. Decidido aplazarlo en la v0.1.0.

## Aplazado

- [ ] Accesos SSH en la lista: tipo de enlace con usuario, host y puerto; en Android abriría
      ssh:// en ConnectBot y en Windows y Linux copiaría el comando ssh; no registrar manejadores del
      sistema por el riesgo de inyección de opciones. Aplazado por decisión del usuario el 2026-10-15.

## Ideas (no prioritarias)

- [ ] Arrastrar enlaces sobre la barra lateral también en la vista normal (hoy solo en el panel).
- [ ] Instalar WebHub como aplicación en el móvil (manifiesto web; ya tiene iconos)
- [ ] Revisión periódica de enlaces rotos con aviso (hoy solo bajo demanda)
- [ ] Buscar en la web cuando no hay resultados y filtrar por etiqueta con un clic
- [ ] Exportar los enlaces como marcadores HTML para otro navegador
- [ ] Analizar también las páginas al importar marcadores (hoy solo al añadir un enlace)
- [ ] Mostrar las etiquetas en la lista y filtrar por etiqueta con un clic
- [ ] Papelera para deshacer borrados
- [ ] Estructura de la página para lectores de pantalla (<main> en la entrada y <h1> en cada vista)
- [ ] ETag en los archivos estáticos