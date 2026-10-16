# Copias de seguridad automáticas de la base de datos

Documento para la persona que configura la copia diaria del servidor (otro
proyecto). Explica qué produce WebHub, dónde vive cada archivo y cómo recogerlo
sin romper nada.

WebHub hace por sí mismo una copia coherente de su base de datos SQLite cada
día. No copia el archivo vivo (`data/webhub.sqlite`): usa `VACUUM INTO`, verifica
la copia y solo entonces la publica. Por eso el archivo que hay que recoger es
estable y seguro de leer en cualquier momento.

## Dónde está todo (ruta real en el servidor)

En producción (Docker) la carpeta por defecto es:

```
/opt/contabo-apps/webhub/data/copias/
```

La base viva está en `/opt/contabo-apps/webhub/data/webhub.sqlite` (no se
recoge).

Carpeta de la aplicación: `/opt/contabo-apps/webhub/`. El directorio de copias
se crea solo; no hace falta crearlo a mano.

## Archivos y retención

| Archivo | Cuándo se crea | Retención |
|---|---|---|
| `webhub-AAAA-MM-DD.sqlite` (fecha UTC) | Una copia diaria; si se repite el día, se sustituye | 14 (configurable) |
| `webhub-manual-AAAA-MM-DD_HHMMSS.sqlite` | Botón «Hacer copia ahora» en Administrar | 10 |
| `webhub-antes-de-restaurar-AAAA-MM-DD_HHMMSS.sqlite` | Antes de restaurar una copia JSON; si falla, la restauración se cancela | 5 |
| `webhub-ultima.sqlite` | Siempre contiene la última copia buena (diaria o manual) | único, se reescribe |

«AAAA-MM-DD» son el año, mes y día en UTC. Los nombres son exactos; no se borra
nada que no tenga uno de esos nombres.

## Qué recoger y qué NO

- **Sí**: `webhub-ultima.sqlite` (o toda la carpeta `data/copias`). Es el
  archivo estable: siempre contiene la última copia buena y es seguro leerlo en
  cualquier momento.
- **No**: la base viva `data/webhub.sqlite`. Está en modo WAL (hay archivos
  `-wal` y `-shm`); una copia con `cp` en caliente puede salir incoherente.

Incluir `data/copias` (o al menos `webhub-ultima.sqlite`) en la copia diaria
del servidor. No incluir `data/webhub.sqlite` ni sus archivos `-wal`/`-shm`.

## Permisos y quién puede leer

- Carpeta: `0700` (`drwx------`).
- Archivos: `0600` (`-rw-------`).

Solo el propietario del directorio (en producción, `sysmarc`, uid 1001) puede
leerlos; `root` también. Otros usuarios no pueden leer ni entrar en la carpeta.

Contienen datos sensibles: el hash del PIN y las claves públicas de las huellas.
Trátalos como secretos: no los subas a repositorios públicos, no los mandes por
correo sin cifrar y no los publiques.

## Comprobar que la copia es reciente

En el servidor (con la fecha de modificación o con `find`):

```sh
find /opt/contabo-apps/webhub/data/copias -name webhub-ultima.sqlite -mmin -2160
```

Si imprime la ruta, la copia tiene menos de 36 horas. También se puede mirar la
fecha de modificación:

```sh
stat /opt/contabo-apps/webhub/data/copias/webhub-ultima.sqlite
```

Desde la web (con sesión): Administrar › Copia de seguridad muestra la última
copia correcta (con «hace X»), cuántas hay, la carpeta, el archivo estable y su
tamaño, un aviso si pasan más de 36 horas sin copia correcta y el último error
si lo hubo.

## Cómo restaurar (paso a paso)

Restaurar desde una copia automática (archivo SQLite):

1. Parar el contenedor:

   ```sh
   docker compose stop webhub
   ```

2. Copiar el archivo elegido sobre la base viva:

   ```sh
   cp /opt/contabo-apps/webhub/data/copias/webhub-ultima.sqlite \
      /opt/contabo-apps/webhub/data/webhub.sqlite
   ```

3. Borrar los archivos WAL auxiliares si existen:

   ```sh
   rm -f /opt/contabo-apps/webhub/data/webhub.sqlite-wal \
         /opt/contabo-apps/webhub/data/webhub.sqlite-shm
   ```

4. Arrancar:

   ```sh
   docker compose up -d
   ```

5. Entrar con el PIN o la huella.

Opcional, comprobar la integridad antes de arrancar:

```sh
sqlite3 /opt/contabo-apps/webhub/data/webhub.sqlite 'PRAGMA integrity_check;'
```

La restauración desde la web (Administrar › Copia de seguridad) de un JSON hace
antes una copia previa (`webhub-antes-de-restaurar-…`); si falla la copia previa,
la restauración se cancela. Nada de la copia incluye el archivo `.env` (solo
contiene el dominio y se recrea copiando `.env.ejemplo`).

## Variables de configuración

| Variable | Por defecto | Uso |
|---|---|---|
| `WEBHUB_BACKUP` | (activado) | `0` desactiva la copia automática. |
| `WEBHUB_BACKUP_DIR` | `./data/copias` (en Docker, `/app/data/copias`) | Carpeta de las copias. |
| `WEBHUB_BACKUP_KEEP` | `14` | Diarias a conservar. Si no es un entero ≥ 1, se usa 14. |
| `WEBHUB_BACKUP_FIRST_DELAY_MS` | `60000` | Espera antes de la primera revisión (solo diagnóstico y pruebas). |

Se definen en el entorno (Docker: en el servicio `webhub` del compose o en
`.env` según corresponda).

## Comprobaciones para dar la configuración por buena

- La copia del servidor contiene `webhub-ultima.sqlite` (o la carpeta
  `data/copias`).
- Abrir el archivo recogido y ejecutar `PRAGMA integrity_check` (debe responder
  `ok`).
- Simular una restauración en otra carpeta (copiar el archivo a un directorio
  temporal y abrirlo; no tocar la base viva).
- Ver en Administrar › Copia de seguridad que la última copia es reciente (menos
  de 36 horas) y no hay error registrado.
