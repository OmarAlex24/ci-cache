# ci-cache

Motor de caché de CI sobre Cloudflare R2: un Worker que guarda la caché de **Turbo**
(Remote Cache API v8) y de **sccache** (backend WebDAV) por repositorio, con un nivel
`main/` que solo escribe la CI de `main` y un nivel por rama que escriben el agente en su
sandbox de Boat y la CI de esa rama.

Sin panel: las métricas salen por una API JSON documentada en [`openapi.yaml`](openapi.yaml)
(OpenAPI 3.1) para conectarla a otro frontend.

## Arquitectura

```
  Sandbox de Boat (agente)        CI de PR / rama            CI de main (push)
  llave sk_... + rama de git      OIDC de GitHub Actions     OIDC de GitHub Actions
            │                              │                          │
            └──────────────┬───────────────┴──────────────────────────┘
                           │  POST /v1/session
                           ▼
        ┌──────────────────────────────────────────────┐
        │ Worker ci-cache (Hono)                       │
        │  1. verifica la credencial                   │
        │     · OIDC: firma (JWKS de GitHub), iss, aud,│
        │       exp/nbf, owner permitido               │
        │     · sk_: sha256 en SANDBOX_KEYS            │
        │  2. decide el nivel por identidad            │
        │  3. firma un token de sesión (HMAC-SHA256)   │
        └──────────────────────┬───────────────────────┘
                               │ token de sesión (6 h)
                               ▼
     turbo ── /v8/artifacts/* ─┐        ┌─ /dav/* ── sccache (RUSTC_WRAPPER)
                               ▼        ▼
        ┌──────────────────────────────────────────────┐
        │ Worker: solo verifica la firma del token     │──► Analytics Engine (METRICS)
        │  nivel → prefijos de lectura/escritura       │    un punto por petición
        └──────────────────────┬───────────────────────┘
                               │ binding CACHE (sin llaves de R2)
                               ▼
        ┌──────────────────────────────────────────────┐
        │ R2: main/<repoId>/{turbo,sccache}/...        │  regla: expira a 30 días
        │     ramas/<repoId>/<branchKey>/{turbo,...}/  │  regla: expira a 7 días
        └──────────────────────────────────────────────┘

  Frontend externo ── GET /v1/stats* (llave rk_ de solo lectura) ──► API SQL de Analytics Engine
```

- `repoId` es el id numérico del repo de GitHub (no cambia si se renombra).
- `branchKey` son los primeros 16 hex de `sha256(nombre de la rama)`.
- El nivel va primero en la llave, así que la caducidad son **2 reglas de R2 para todos
  los repos**.

## Niveles y por qué evitan el envenenamiento

El cliente **nunca elige su nivel**: sale de quién es.

| Identidad | Nivel | Lee | Escribe |
| --- | --- | --- | --- |
| OIDC, evento en `MAIN_WRITE_EVENTS` (default `push`) sobre una ref de `MAIN_REFS` | `main` | `main/` | `main/` |
| OIDC con `head_ref` (pull_request, pull_request_target) | `rama` = `head_ref` | su rama, luego `main/` | su rama |
| OIDC, otro evento sobre una ref de main (schedule, workflow_dispatch...) | `main-ro` | `main/` | nada (403) |
| OIDC sobre cualquier otra ref (push a una rama, tags) | `rama` = nombre de la ref | su rama, luego `main/` | su rama |
| Llave de sandbox `sk_...` | **siempre** `rama` (aunque la rama se llame `main`) | su rama, luego `main/` | su rama |

El orden de evaluación es ese mismo: `head_ref` se mira antes que "ref de main" porque
`pull_request_target` trae `ref = refs/heads/main` (la rama base) y debe quedar en `rama`.

**Por qué no hay envenenamiento:** lo único que lee la CI de `main` es `main/`, y en `main/`
solo escribe la propia CI de `main` (push, con OIDC firmado por GitHub). Si un agente en
un sandbox produce un artefacto malo — por un bug, por un entorno distinto o a propósito —
queda en `ramas/<repoId>/<branchKey>/` y como mucho lo reutiliza la CI de esa misma rama.
Nunca llega a `main/`, así que nunca lo reutilizan `main` ni las demás ramas. Una llave de
sandbox robada solo puede escribir en ramas, que caducan en 7 días.

## Endpoints

Detalle completo en [`openapi.yaml`](openapi.yaml).

| Endpoint | Credencial | Qué hace |
| --- | --- | --- |
| `GET /health` | ninguna | comprobación de vida |
| `POST /v1/session` | OIDC o `sk_...` | emite el token de sesión |
| `GET /v8/artifacts/status` | sesión | `{"status":"enabled"}` |
| `GET`/`HEAD`/`PUT /v8/artifacts/{hash}` | sesión | artefactos de Turbo |
| `POST /v8/artifacts` | sesión | consulta en lote |
| `POST /v8/artifacts/events` | sesión | eventos de turbo (se validan y descartan) |
| `GET`/`PUT`/`PROPFIND /dav/...` | sesión | WebDAV para sccache |
| `GET /v1/stats?repo=&range=` | `rk_...` | aciertos, fallos, bytes, tiempo ahorrado, por nivel, kind y protocolo |
| `GET /v1/stats/branches?repo=&range=` | `rk_...` | reutilización por rama y `reuseAlert` |

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

Para que sccache acierte entre sandbox y CI, la ruta del checkout, el toolchain y las
banderas deben coincidir (ver `scripts/cache-fingerprint.sh`) y `CARGO_INCREMENTAL=0`
(sccache no cachea compilaciones incrementales).

## Métricas

Cada petición de caché (GET o PUT de un objeto; no los HEAD, la consulta en lote ni
`.sccache_check`) escribe un punto en Workers Analytics Engine:

| Columna | Valor |
| --- | --- |
| `index1` | repoId |
| `blob1` | repoId |
| `blob2` | nivel: `main` \| `main-ro` \| `rama` |
| `blob3` | kind de la sesión: `ci` \| `sandbox` |
| `blob4` | protocolo: `turbo` \| `sccache` |
| `blob5` | resultado: `hit` \| `hit-main` \| `miss` \| `write` |
| `blob6` | writer-kind del objeto leído (`ci` \| `sandbox`; vacío en fallos) |
| `blob7` | rama de la sesión |
| `double1` | bytes |
| `double2` | duración guardada del artefacto en ms (`x-artifact-duration` de Turbo; 0 en sccache) |

`hit-main` es un acierto de nivel `rama` servido desde `main/`. `/v1/stats*` consulta la
API SQL de Analytics Engine y suma `_sample_interval` (no `COUNT()`), así que los conteos
siguen siendo correctos si AE muestrea. AE guarda los datos 3 meses: el rango máximo es `90d`.

`reuseAlert` en `/v1/stats/branches` es `true` cuando el sandbox escribió al menos
`REUSE_ALERT_MIN_WRITES` objetos en una rama y la CI de esa rama no acertó ninguno de
ellos: casi siempre significa que algo entra distinto en las llaves de caché.

## Configuración

### Bindings (`wrangler.jsonc`)

| Binding | Tipo | Para qué |
| --- | --- | --- |
| `CACHE` | R2 (`ci-cache`) | la caché; el Worker no tiene llaves de R2 |
| `METRICS` | Analytics Engine (dataset `ci_cache`) | un punto por petición |

### Vars (`wrangler.jsonc`)

| Var | Default | Qué es |
| --- | --- | --- |
| `CACHE_AUDIENCE` | `ci-cache` | `aud` que deben traer los OIDC de GitHub |
| `ALLOWED_OWNERS` | `OmarAlex24` | dueños de GitHub permitidos, separados por comas (sin distinguir mayúsculas) |
| `MAIN_WRITE_EVENTS` | `push` | eventos que escriben en `main/` |
| `MAIN_REFS` | `refs/heads/main,refs/heads/master` | refs que cuentan como main |
| `SESSION_TTL_SECONDS` | `21600` (6 h) | vida del token de sesión |
| `MAX_ARTIFACT_BYTES` | `104857600` (100 MB) | tope por objeto en PUT |
| `METRICS_DATASET` | `ci_cache` | dataset de AE; debe coincidir con el binding `METRICS` |
| `REUSE_ALERT_MIN_WRITES` | `20` | umbral de `reuseAlert` |

### Secrets (`wrangler secret put`)

| Secret | Qué es |
| --- | --- |
| `SESSION_SECRET` | llave HMAC de los tokens de sesión, ≥ 32 caracteres aleatorios |
| `SANDBOX_KEYS` | JSON `{"<sha256 de la llave>": {"repoId": 123, "repo": "owner/repo", "label": "..."}}` |
| `STATS_KEYS` | JSON `{"<sha256 de la llave>": {"label": "...", "repoIds": [123]}}` (`repoIds` opcional limita los repos) |
| `CF_ACCOUNT_ID` | cuenta de Cloudflare, para la API SQL de Analytics Engine |
| `CF_API_TOKEN` | token de API con permiso *Account Analytics: Read* |

Las llaves se generan con `node scripts/new-key.mjs sandbox <repoId> <owner/repo> [etiqueta]`
o `node scripts/new-key.mjs stats <etiqueta> [repoId,...]`: imprime la llave (solo esa vez)
y la entrada con su hash para fusionar en el secret. El Worker nunca guarda llaves en claro.

## Desplegar con wrangler

```sh
pnpm install
pnpm wrangler login

# 1. Bucket y las 2 reglas de ciclo de vida (sirven para todos los repos)
pnpm wrangler r2 bucket create ci-cache
pnpm wrangler r2 bucket lifecycle add ci-cache ramas-7d ramas/ --expire-days 7 --force
pnpm wrangler r2 bucket lifecycle add ci-cache main-30d main/ --expire-days 30 --force
pnpm wrangler r2 bucket lifecycle list ci-cache

# 2. Secrets
openssl rand -base64 48 | pnpm wrangler secret put SESSION_SECRET
pnpm wrangler secret put SANDBOX_KEYS      # pega el JSON de hashes
pnpm wrangler secret put STATS_KEYS
pnpm wrangler secret put CF_ACCOUNT_ID
pnpm wrangler secret put CF_API_TOKEN

# 3. Revisa ALLOWED_OWNERS y CACHE_AUDIENCE en wrangler.jsonc y despliega
pnpm check
pnpm run deploy
```

El dataset de Analytics Engine se crea solo con el primer `writeDataPoint`.

Las reglas de R2 caducan por **fecha de subida**, no de último uso: un artefacto de
`main/` muy usado igual desaparece a los 30 días, la siguiente CI de `main` falla una vez
y lo vuelve a escribir.

## Límites

- **100 MB por petición**: es el tope de cuerpo de un Worker (planes Free y Pro; Business
  200 MB, Enterprise 500 MB). `MAX_ARTIFACT_BYTES` lo aplica antes de tocar R2 (413). Un
  artefacto de Turbo más grande no se guarda: turbo avisa y sigue sin caché para esa tarea.
- `PUT` exige `Content-Length` (411 si falta): el cuerpo va en streaming a R2 sin cargarlo
  en memoria, y R2 necesita conocer la longitud.
- Hashes de Turbo: hexadecimales de 1 a 128 caracteres. Rutas de sccache: segmentos
  `[A-Za-z0-9._-]`, máximo 512 caracteres.
- Consulta en lote: 1000 hashes; cuerpos JSON de hasta 1 MB.
- Ante un 403, turbo desactiva la caché remota **para el resto del run**, así que con un
  token `main-ro` hay que usar la caché remota en solo lectura (`--cache=local:rw,remote:r`
  o `TURBO_CACHE`), si no las tareas siguientes dejan de leer `main/`.

## Integrar

### CI de GitHub Actions: `setup/action.yml`

```yaml
permissions:
  contents: read
  id-token: write          # para pedir el OIDC de GitHub

jobs:
  build:
    runs-on: boat-large
    steps:
      - uses: actions/checkout@v5
      - id: cache
        uses: OmarAlex24/ci-cache/setup@<sha>
        with:
          url: https://ci-cache.<cuenta>.workers.dev
          mount-workdir: "true"   # compila en /home/user/<repo>, como los sandboxes
      - working-directory: ${{ steps.cache.outputs.workdir }}
        run: |
          pnpm turbo run build
          cargo build --locked
          sccache --show-stats
```

La acción pide el OIDC (`ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`) con la audiencia
`audience` (default `ci-cache`), llama `POST /v1/session`, enmascara los tokens
(`::add-mask::`) y exporta:

- `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` (= nombre del repo; turbo exige un team y el
  Worker lo ignora). Con nivel `main-ro` también `TURBO_CACHE=local:rw,remote:r`, porque
  ante un 403 turbo apaga la caché remota del run entero.
- Si hay Rust (`sccache: auto` busca un `Cargo.toml`): instala sccache fijado por versión
  y SHA-256 (0.19.0 por defecto, x86_64 y aarch64; otra versión exige `sccache-sha256`) y
  exporta `RUSTC_WRAPPER=sccache`, `SCCACHE_WEBDAV_ENDPOINT=<url>/dav`,
  `SCCACHE_WEBDAV_TOKEN` y `CARGO_INCREMENTAL=0`.
- `mount-workdir: "true"` monta el checkout con `sudo mount --bind "$GITHUB_WORKSPACE"
  /home/user/<repo>` (la ruta donde clonan los sandboxes de Boat) para que las llaves de
  sccache coincidan; el output `workdir` dice dónde compilar.
- Outputs: `tier`, `branch`, `expires-at`, `workdir`.
- Después imprime la huella de caché (`scripts/cache-fingerprint.sh`; `fingerprint: "false"`
  para omitirla): compárala con la del sandbox para ver por qué no acierta.

### Sandbox de Boat: `scripts/ci-cache-env.sh`

```sh
# Una vez por repo: node scripts/new-key.mjs sandbox <repoId> <owner/repo> boat
# y guarda la llave en los secretos del sandbox como CI_CACHE_SANDBOX_KEY.
export CI_CACHE_URL=https://ci-cache.<cuenta>.workers.dev
cd /home/user/<repo>
bash ci-cache-env.sh            # toma la rama de git; CI_CACHE_BRANCH para otra
source ~/.ci-cache.env
```

Escribe en `~/.ci-cache.env` (permisos 600) `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM`,
`SCCACHE_WEBDAV_ENDPOINT`, `SCCACHE_WEBDAV_TOKEN`, `CARGO_INCREMENTAL=0` y, si sccache
está instalado, `RUSTC_WRAPPER=sccache`; reinicia el servidor de sccache para que tome el
token nuevo. Una llave de sandbox siempre da nivel `rama`. El token dura 6 h: vuelve a
correr el script si la sesión del agente dura más.

Para que sccache acierte entre sandbox y CI, ambos deben compilar en la misma ruta
(`/home/user/<repo>`), con el mismo toolchain y las mismas banderas.

## Desarrollo

```sh
pnpm install
cp .dev.vars.example .dev.vars      # pon un SESSION_SECRET
pnpm dev                            # wrangler dev con R2 local
pnpm check                          # typecheck + oxlint + vitest (Workers runtime, R2 local)
pnpm e2e                            # turbo 2.11.10, sccache, ci-cache-env.sh y setup.sh reales
pnpm lint:openapi                   # valida openapi.yaml (descarga @redocly/cli)
pnpm lint:sh                        # shellcheck de los scripts de cliente
```

- `pnpm e2e:turbo` y `pnpm e2e:sccache` levantan su propio `wrangler dev` con R2 en un
  directorio temporal y firman tokens de sesión con el `SESSION_SECRET` de `.dev.vars`
  (`scripts/mint-session.mjs`); no hay rutas de solo-desarrollo en el Worker. Para usar uno
  ya levantado: `CI_CACHE_URL=http://127.0.0.1:8787 pnpm e2e:turbo`.
- `pnpm e2e:sandbox` prueba `ci-cache-env.sh` con una llave de sandbox generada al vuelo
  (pasada a `wrangler dev` con `--var SANDBOX_KEYS`). `pnpm e2e:setup` prueba
  `setup/setup.sh` con un servidor que simula el OIDC de GitHub y `/v1/session` (el OIDC
  real solo existe dentro de Actions) y, si hay Docker, corre en Ubuntu la instalación de
  sccache por SHA-256 y el `mount --bind`.
- Analytics Engine no se puede consultar en local: la consulta está detrás de la interfaz
  `AnalyticsClient` y las pruebas verifican el SQL generado y la forma de las respuestas.

## Seguridad

- Todo endpoint salvo `/health` exige token; los tres tipos (sesión, `sk_`, `rk_`) no se
  aceptan fuera de su sitio.
- Las llaves se guardan como sha256 y se comparan en tiempo constante contra todas las
  entradas; la firma del token de sesión se verifica con `crypto.subtle.verify`.
- Los tokens nunca se registran; los errores son JSON genéricos sin detalles internos.
- No hay endpoints de listado (PROPFIND solo con `Depth: 0`).

## Atribución

Los tipos de la API de Turbo (`src/turbo/spec.ts`) vienen del spec de
[AdiRishi/turborepo-remote-cache-cloudflare](https://github.com/AdiRishi/turborepo-remote-cache-cloudflare),
MIT, © 2023 Adishwar Rishi.
