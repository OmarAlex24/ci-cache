# Case study: the first rollout

The reference repo is a Rust workspace (12 crates), a browser extension (pnpm, wasm),
two Docker images and a Postgres suite. Its CI is one boated job (`ci`, on
`boat-large`, 8 vCPU / 16 GB) with 7 background tasks: fmt, clippy, test,
test (postgres), docker, extension and cargo-deny. Each task shares one
`target/` and publishes its own check.

## Timeline (one PR per row, in merge order)

| Change | What it taught |
| --- | --- |
| ci-cache action + bind mount at `/home/user/<repo>`; rust-cache moved **after** the action, `prefix-key v1-rust`, still caching `target/` | First run fully cold: 1 hit / 1853 misses, 16m27s. sccache read 0.067 s and write 0.201 s on average with the weur bucket (it was 0.869 s and 0.727 s with WNAM). An earlier attempt with rust-cache **before** the action got 0/36: a `target/` built without sccache poisoned the keys. |
| rust-cache `cache-targets: false`, `prefix-key v2-rust`: `~/.cargo` only | With main's `target/` restored the job took **14.7 min**: restoring ~890 MB took ~60 s before any task started. A warm sccache with no `target/` started the tasks at +17 s, hit 98 % and took **~8 min**. |
| docker: BuildKit `type=gha` `mode=max`; the Railway image reuses the root image's binary (`--build-context build=docker-image://…`, guarded by a stage comparison) | `docker` 406–485 s → **23 s** warm (root image 11 s, all `CACHED`). The cold first write to a scope uploads ~353 MB at 4–6 MB/s (72–89 s). |
| extension: Chromium deps and download in the background; `--no-shell`; dpkg `force-unsafe-io` | `extension` ~636 s → **287 s** at best; `install-deps` 53–232 s → 18 s. pnpm's store can't hard-link across the bind mount (EXDEV). |
| docker: retry **any** failed cached build once without the cache | `ignore-error=true` covers only the export; a 5xx while reading the cache would turn the task red. |
| cargo-nextest for `test` and `test (postgres)`; `.config/` added to `.dockerignore` | `test` busy-machine median 574 → 366 s. A new root-level config dir had been invalidating the Docker context. |
| `CLAUDE.md`: in a Boat sandbox, install sccache, open a session and `source ~/.ci-cache.env` before building | The agent guide is the only startup hook sandboxes have (`sandbox.md`). |
| docker: the build stage copies only `Cargo.toml`, `Cargo.lock` and `crates/`, in both Dockerfiles | A change outside `crates/` costs a cached build (21 s) instead of a recompile (149–331 s, n=4, fast machines). But on main's last 80 commits it avoids only 7 of 45 recompiles. The images were proved equal file by file. |
| `rust-toolchain.toml` pins 1.97.1; the toolchain step renames the image's `stable` to the pinned name before any rustup call | Pinning the image's own release still downloaded it: 150 s and 5.6 s. With the rename first, the step is back to 2–3 s. sccache stayed at 100 % throughout. |

## Numbers

| | Before | After |
| --- | ---: | ---: |
| Job `ci`, median of first attempts | 12.4 min (n = 53 PRs before onboarding) | ~11.4 min after the extension change (n = 5); ~10 min with nextest (n = 4) |
| Rust hit rate, warm main | — | 99.84 % |
| PR CI reuse of the sandbox's objects | — | 96 % (one branch: 1302 of 1355) |
| `docker` task | 406–485 s | 23 s warm |
| `docker` task, change outside `crates/`, fast machines | 149–331 s (n=4) | 21 s (n=1), after narrowing the build stage |
| Toolchain step with the pinned release | 150 s and 5.6 s (pin alone, n=2) | 2–3 s (renamed first, n=2) |
| `extension` task | ~636 s | 287 s at best |

The variance is mostly the machine class. Fast machines (iowait ~2 %) ran
the job in ~333–434 s, and slow-io machines (15–23 %) in ~536–702 s, for
the same work.

## What it cost

- One cold `main` run after each key-space change: the onboarding, the
  `prefix-key` bump, the `.dockerignore` change.
- The Actions cache went over 10 GB once (11.4 GB). About 4.8 GB of that
  was `v0-rust` entries from old PRs, and about 4.7 GB was main's
  `v1-rust` with `target/`. The `v0` and `v1` entries were deleted with
  the repo owner's OK. After the cleanup it held ~2.2 GB in 75 entries.
  - BuildKit blobs are stored per ref: each PR that built Docker holds its
    own ~353 MB until they expire after 7 days unused.
- One sandbox key leaked twice through `boat env info`, and was rotated
  each time.
- One `docker` compile on the toolchain PR's first run (357 s): a stacked
  PR reads main's BuildKit cache, which didn't have the narrowed build
  stage yet.

## What is left on the critical path

`extension`'s single-worker Playwright e2e (3.5–5.7 min) doesn't depend on
any cache. That is the next lever, and it's not a caching one.

Smaller items:
- Copying only `app-server`'s own crates into the image, with stub
  manifests, would avoid 22 of main's 45 recompiles instead of 7
  (`docker.md`).
- Each sandbox downloads the pinned toolchain once (`roadmap.md`).
