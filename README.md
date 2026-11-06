# ci-cache

Motor de caché de CI sobre Cloudflare R2: un Worker que guarda la caché de Turbo y sccache por repositorio, con un nivel `main/` que solo escribe la CI de `main` y un nivel por rama que escriben el agente en su sandbox y la CI de esa rama.

Sin panel: las métricas salen por una API documentada en OpenAPI.

## sccache (WebDAV)

Probado con **sccache 0.19.0** (backend `webdav` de OpenDAL) contra `wrangler dev`. Con
`SCCACHE_WEBDAV_ENDPOINT=https://<worker>/dav` y `SCCACHE_WEBDAV_TOKEN=<token de sesión>`,
sccache solo usa estos verbos, y son los únicos que implementa el Worker:

| Verbo | Ruta | Cuándo |
| --- | --- | --- |
| `GET` | `/dav/.sccache_check` | al arrancar el servidor, para comprobar lectura |
| `PROPFIND` (`Depth: 0`) | `/dav/` y `/dav/<a>/<b>/<c>/` | antes de cada escritura, para saber si existe el directorio padre; exige `getlastmodified` en la respuesta |
| `PUT` | `/dav/.sccache_check` | al arrancar, para comprobar escritura (un 403 deja a sccache en solo lectura) |
| `GET` | `/dav/<a>/<b>/<c>/<hash>` | buscar un objeto compilado |
| `PUT` | `/dav/<a>/<b>/<c>/<hash>` | guardar un objeto compilado |

`MKCOL` solo aparece si `PROPFIND` dice que el directorio no existe; como R2 no tiene
directorios, el Worker responde que todos existen y sccache nunca lo manda. Cualquier
otro verbo responde 405 y `PROPFIND` con `Depth` distinto de 0 responde 403 (no hay
listados). Si el endpoint termina en `/`, sccache manda `/dav//...`; el Worker lo tolera.
