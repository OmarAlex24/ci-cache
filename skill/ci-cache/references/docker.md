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
- Narrowing the build stage's COPY: check before you count on it
- Prove that the image didn't change
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

In the first rollout, this removed the second release compile (79–154 s).
A change to the build stage, such as a narrower `COPY`, goes into both
Dockerfiles with the same lines, or the comparison stops matching and the
variant compiles again.

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
  it. A narrower `COPY` in the build stage gets the same effect for the
  compile layer only (next section).

## Narrowing the build stage's COPY: check before you count on it

The first rollout replaced the build stage's `COPY . .` with `Cargo.toml`,
`Cargo.lock` and `crates/`. `.dockerignore` stayed as it was: it still
keeps the context small, and the runtime stages still copy files from
outside `crates/` (an entrypoint script).

- **What it buys**: a change outside `crates/` costs a cached build. The
  `docker` task took 21 s (n=1, fast machine) where such a change used to
  recompile in 149–331 s (n=4, fast machines).
- **How often it pays**: less than it sounds in a Rust-heavy repo, where
  most commits touch the crates anyway. On main's last 80 commits the old
  context changed in 45 and the new one in 38: 7 fewer recompiles. Over
  the last 60 merged PRs, 29 against 23.
- **Narrower still**: copying only the server's own crates, with stub
  manifests for the other workspace members, would avoid 22 of those 45.
  It needs an extra stage in each Dockerfile and a list to keep in sync,
  so it was left as a possible follow-up.

Before you narrow:
1. **Check what actually invalidates the layer.** There, `.dockerignore`
   already excluded `apps/` and `.github/`, so changes there never rebuilt
   the image. What did were `scripts/`, `deploy/`, `packages/` and root
   files.
2. **Count the recompiles it would have saved.** Replay the default
   branch's recent commits, and for each one ask whether its files fall in
   the layer's old inputs and in the new ones. Every input counts,
   including the Dockerfile and `.dockerignore`. A sketch for the new side:

   ```bash
   git log -80 --format=%H origin/main | while read -r c; do
     git diff-tree --no-commit-id --name-only -r "$c" |
       grep -qE '^(Cargo\.toml|Cargo\.lock|crates/|Dockerfile$|\.dockerignore$)' && echo "$c"
   done | wc -l
   ```

   The old side is every file that `.dockerignore` lets in. Squash-merged
   repos give one commit per PR; with merge commits, use `--first-parent`.
3. **Put the build's inputs in a comment** in the Dockerfile: a future
   build input outside the copied paths needs its own `COPY`, in every
   Dockerfile that shares the stage.
4. **Prove the image didn't change** (next section).

## Prove that the image didn't change

A PR that changes how an image is built, but shouldn't change what it
contains, proves it in CI with a temporary commit that a later commit
reverts (`measurement.md`). The first rollout did it like this:

1. **Rebuild the old image first**: the default branch's Dockerfiles on
   the same context (`git archive HEAD` into a directory), reading the
   default branch's cache with `--cache-from type=gha,scope=<image>` and no
   `--cache-to`. Run it before the PR's own build writes the PR's cache
   index, so it reads main's, and so that index holds only the real build.
2. **Compare every file**, with its mode, owner, size and SHA-256, as root
   and with the image's entrypoint bypassed:

   ```bash
   files() {
     docker run --rm --user 0:0 --network none --entrypoint /bin/sh "$1" -c '
       skip="( -path /proc -o -path /sys -o -path /dev -o -path /etc/hostname -o -path /etc/hosts -o -path /etc/resolv.conf -o -path /.dockerenv ) -prune -o"
       find / -xdev $skip -printf "%p %y %#m %U:%G %s %l\n" | LC_ALL=C sort
       find / -xdev $skip -type f -print0 | xargs -0 sha256sum | LC_ALL=C sort -k2'
   }
   diff <(files <image>:before) <(files <image>:ci)
   ```

   The image needs `sh`, GNU `find` and `sha256sum`. Then compare the
   config fields that matter, not the whole `inspect`, which holds IDs and
   dates:

   ```bash
   docker image inspect --format '{{.Os}}/{{.Architecture}} user={{json .Config.User}} env={{json .Config.Env}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} workdir={{json .Config.WorkingDir}} volumes={{json .Config.Volumes}} ports={{json .Config.ExposedPorts}} healthcheck={{json .Config.Healthcheck}} labels={{json .Config.Labels}} stopsignal={{json .Config.StopSignal}}' <image>
   ```
3. **Probe with builds that use no cache flags.** The local builder already
   holds the layers the PR's build just made. Change a file that must not
   reach the compile layer and check that the layer stays `CACHED` in
   `--progress=plain`, then change a source file and check that it
   compiles.

This works only if the build is reproducible: the new image's binary is
compiled fresh. In the first rollout, two runs on main had compiled the
same `app-server` independently. The result: 8,194 identical
lines for the root image and 8,196 for Railway's, the same config, and the
same binary hash in all four images. A change in `scripts/` left the
compile layer `CACHED`, and a change in `crates/app-server/src/main.rs`
compiled.

## Costs and numbers

From the first rollout, `docker` task seconds:

| Scenario | Task | Notes |
| --- | ---: | --- |
| Before, no cache, two compiles | 406–485 | |
| Cold, empty scope | 222–385 | the cache export took 72–89 s |
| Warm, unchanged context, busy machine | 262 | `docker run` checks were slow from iowait |
| Warm, unchanged context | **23** | root image 11 s, all stages `CACHED` |
| Compile layer cached, fast machines (before narrowing the `COPY`) | 18–33 | n=6, median 21 |
| Compile layer cached, slow-io machines | 107–252 | n=3, iowait 18–25 % |
| Compile layer rebuilt, fast machines | 149–331 | n=4; two of them changed only `scripts/` |
| Change outside `crates/`, after narrowing the `COPY` | 21 | n=1, compile layer `CACHED` |

- **Slow cached runs are slow machines, not misses.** On slow-io machines
  the time went into `docker run` and `sha256sum`, with the compile layer
  cached. Classify the machine (`machine-class.sh`) before blaming the
  cache.
- **Uploads to the GitHub cache run at 4–6 MB/s from Boat.** The first
  write to a scope uploads the base image's big layer (252 MB for `rust`),
  which costs **~70–90 s**. That happens once per scope, then the scope
  stays the same size.
- **A compile-layer miss also pulls that base layer** from the Actions
  cache (292 MB in that count): 18–22 s on one day, but 84 s and 400 s
  two days later. A miss costs the compile plus this pull.
- **A stacked PR's first run reads main's BuildKit cache, not its parent
  PR's.** After a Dockerfile change in the base PR, the first run of the PR
  above it compiles. A toolchain PR stacked on the narrowed-`COPY` PR
  compiled `app-server` in its first run (357 s), because main's cache
  still had the `COPY . .` layout. Its next runs read its own cache: 19 s and 33 s.
- Each scope takes Actions cache space (353 MB in the first rollout) toward the
  **10 GB** limit. GitHub evicts the least recently used entries first.
  - Entries are stored **per ref**. There, each PR that built the image
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
