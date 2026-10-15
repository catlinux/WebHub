# TODO

## Pendiente

- [ ] Copia automática de `data/` en el VPS (temporizador con `VACUUM INTO`) y confirmar si la copia Borg
      del servidor incluye `/opt/contabo-apps/webhub/data`.
- [ ] Comprobar la entrada con huella en un móvil real y en el dominio de producción, y anotar el
      resultado en docs/despliegue.md.
- [ ] Comprobar el aspecto configurable y las familias plegadas en un móvil real y en producción.

## Pendiente de decidir

- [ ] Campo «Referencia KeePassXC» por enlace (solo texto con la ruta de la entrada, p. ej. `Proveedores/OVH`,
      con botón de copiar). Nunca guardar secretos en WebHub. Decidido aplazarlo en la v0.1.0.
- [ ] Accesos SSH en la lista (idea): tipo de enlace con usuario, host y puerto; en Android abriría
      ssh:// en ConnectBot y en Windows y Linux copiaría el comando ssh. No registrar manejadores del
      sistema (riesgo de inyección de opciones). Pendiente de la decisión del usuario.

## Ideas

- [ ] Arrastrar enlaces sobre la barra lateral también en la vista normal (hoy solo en el panel).
