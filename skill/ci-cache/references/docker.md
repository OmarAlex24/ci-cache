# Docker: BuildKit's cache in the Actions cache

sccache does not reach `docker build`, because the build runs inside
BuildKit with its own environment. Cache the image layers with BuildKit's
`type=gha` backend, which stores them in the repository's GitHub Actions
cache. That needs no registry and no `packages: write`.

## Contents
- Export the cache runtime
- Build with the cache, retry without it
- Don't compile the same binary twice
- Keep the build context stable
- Costs and numbers
- What not to do

## Export the cache runtime

The runner hands the cache runtime (a token and URLs) to **actions** only,
not to `run:` steps. One `actions/github-script` step exports it for the
steps and background tasks that follow:

```yaml
      - name: "docker: Actions cache runtime for BuildKit"
        continue-on-error: true   # without it the images build uncached
        uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
        with:
          script: |
            for (const name of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_CACHE_URL", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_SERVICE_V2"]) {
              const value = process.env[name];
              if (!value) { core.info(`${name}: not set`); continue; }
              if (name === "ACTIONS_RUNTIME_TOKEN") core.setSecret(value);
              core.exportVariable(name, value);
              core.info(`${name}: exported`);   // the name only, never the value
            }
```

This is the job's own token. A PR reads main's entries and writes only to
its own ref, like `actions/cache`. On Boat, all four variables arrive.

If the build runs in a background task that pipes its output to a file
(boated-ci's `ci-task.ts`), the runner's masking doesn't apply. The task
engine masks the log before storing it. Either way, never echo these
variables.

## Build with the cache, retry without it

`ignore-error=true` on `--cache-to` only covers the **export**. A cache that
can't be set up or read fails the build, and the error messages vary (a 5xx
from the cache service, a bad token). So retry **any** failed build once
without the cache. A real build error fails both times, so the task is
still red for it.

```bash
cache=()
# `:+set`, not the value: set -x prints the test
if [ -n "${ACTIONS_RUNTIME_TOKEN:+set}" ] && [ -n "${ACTIONS_RESULTS_URL:-}${ACTIONS_CACHE_URL:-}" ]; then
  cache=(--cache-from "type=gha,scope=<image>"
         --cache-to   "type=gha,scope=<image>,mode=max,ignore-error=true")
else
  echo "No Actions cache runtime: the images build uncached"
fi
if ! docker build "${cache[@]}" -t <image>:ci .; then
  [ "${#cache[@]}" -gt 0 ] || exit 1
  echo "::warning::docker build failed with the BuildKit cache: building without it"
  docker build -t <image>:ci .
fi
```

- **`mode=max`** also exports the intermediate stages, so the compile stage
  is cached when the context did not change. `mode=min` exports only the
  final image's layers. With the `docker` driver it exported the same
  ~323 MB, so it gains nothing.
- **One `scope` per image.** Two images sharing a scope overwrite each
  other's index.
- **Cache mounts** (`RUN --mount=type=cache,target=…`) live in the builder.
  They never reach `type=gha`. A context change rebuilds the stage from
  scratch.
- Docker can answer a few seconds after a Boat machine reports ready. Wait
  for `docker info`, with a timeout, **inside** the task, so a rerun that
  runs only that task also waits.

## Don't compile the same binary twice

When a second image (a deploy variant, a Railway or Fly image) has the same
build stage as the main one, feed it the image you already built:

```bash
docker build -f deploy/<variant>/Dockerfile \
  --build-context build=docker-image://<image>:ci -t <image>-<variant>:ci .
```

The `build` stage then **is** the first image, so the binary must be at the
same path. Guard it with a textual comparison of the two build stages, and
fall back to a full build when they differ:
1. Join continuation lines.
2. Drop `--mount=type=cache,…`, comments and blank lines.
3. Squeeze whitespace.
4. Compare the lines between `FROM … AS build` and the next `FROM`.
5. Also require that the variant's only `COPY --from=build` is the binary.

Afterwards, check that both images contain the same binary by comparing
`sha256sum` inside each one.

In klav, this removed the second release compile (79–154 s).

## Keep the build context stable

With `COPY . .`, anything that `.dockerignore` lets in is part of the
context. One changed file invalidates the compile layer.
- A **denylist** `.dockerignore` (`target/`, `.git/`, `docs/`…) lets every
  **new** root-level file in. When the repo adds CI-only config
  (`.config/nextest.toml`, `.github/`, tool configs), add it to
  `.dockerignore` in the same PR.
- `.dockerignore` is itself part of the context. Editing it rebuilds once,
  and the next runs hit.
- Exclude `rust-toolchain.toml` if the image uses its base image's
  toolchain. Otherwise the image installs the pinned components for
  nothing.
- An **allowlist** (`*` then `!crates/`, `!Cargo.toml`, `!Cargo.lock`) is
  the most stable choice, but it's more invasive. Propose it, don't impose
  it.

## Costs and numbers

From klav, `docker` task seconds:

| Scenario | Task | Notes |
| --- | ---: | --- |
| Before, no cache, two compiles | 406–485 | |
| Cold, empty scope | 222–385 | the cache export took 72–89 s |
| Warm, unchanged context, busy machine | 262 | `docker run` checks were slow from iowait |
| Warm, unchanged context | **23** | root image 11 s, all stages `CACHED` |

- **Uploads to the GitHub cache run at 4–6 MB/s from Boat.** The first
  write to a scope uploads the base image's big layer (252 MB for `rust`),
  which costs **~70–90 s**. That happens once per scope, then the scope
  stays the same size.
- Each scope takes Actions cache space (353 MB for klav's) toward the
  **10 GB** limit. GitHub evicts the least recently used entries first.
  - Entries are stored **per ref**. In klav, each PR that built the image
    held its own ~353 MB copy of the same blobs (`buildkit-blob-1-sha256:…`
    under `refs/pull/<n>/merge`), next to main's.
  - Those copies expire after 7 days unused. Budget for the PRs open at
    once.
  - `audit-cache.sh` lists the usage by key prefix and by ref.
- Start the Docker task **first**. It needs none of the Rust or Node setup,
  so it overlaps the setup steps.

## What not to do

- **`type=registry` on GHCR** needs `packages: write` in a job that runs PR
  code.
- **Persisting cache mounts with the "cache dance"** (`target/` and the cargo
  registry through `actions/cache`) means restoring and saving ~1 GB per
  run. Only worth it if Docker is on the critical path after the steps
  above.
- **Docker temporary credentials for ci-cache** don't exist yet (v2), so
  BuildKit can't use the R2 tiers.
