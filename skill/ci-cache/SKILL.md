---
name: ci-cache
description: Onboard a repo onto Omar's ci-cache engine (a Cloudflare Worker on R2 serving the Turbo remote cache and an sccache WebDAV backend; a main/ tier written only by CI on main, per-branch tiers shared by Boat sandboxes and PR CI) and get the most out of it. It audits stacks and existing caches, wires Rust (sccache, the /home/user/<repo> bind mount, rust-cache order), Turbo and Docker (BuildKit type=gha) into GitHub Actions, wires Boat sandboxes (CI_CACHE_SANDBOX_KEY, ci-cache-env.sh), mints keys without printing them, checks cache-key parity, reads /v1/stats and measures the gain. Use it whenever the user mentions ci-cache or its setup action, sccache or RUSTC_WRAPPER, a remote compile cache, Turbo remote cache or TURBO_TOKEN, Swatinem/rust-cache, BuildKit or Docker layer caching in CI, cache hit rate or misses, a sandbox build CI did not reuse, reuseAlert, the 10 GB Actions cache limit, or making Boat CI faster with caching, even if they never say ci-cache.
---

# CI cache (ci-cache engine)

**ci-cache** is a remote build cache that a Boat sandbox and GitHub Actions
share. An agent compiles in its sandbox, the PR's CI reuses those objects,
and every branch falls back to what `main` built. It caches *inside* jobs.
The `boated-ci` skill is its complement: it cuts the number of jobs
(machine starts). Use boated-ci to consolidate the jobs, then this skill to
make the one heavy job fast.

A cache only pays when the two sides produce **byte-identical cache keys**:
same path, toolchain, flags and environment. Most of this skill is about
getting that parity and proving it with numbers.

## Bundled resources

| Path | Use it for |
| --- | --- |
| `scripts/audit-cache.sh` | Stack detection, cache steps in the workflows, Actions cache usage vs the 10 GB limit. Run first. |
| `scripts/mint-sandbox-key.sh` | Mint a sandbox key and merge it into the local key files without printing it. |
| `scripts/fingerprint-diff.sh` | Diff the sandbox and CI cache fingerprints; flags the lines that break keys. |
| `scripts/cache-stats.sh` | Read `/v1/stats` and `/v1/stats/branches` (sandbox→CI reuse per branch). |
| `scripts/job-durations.sh` | First-attempt job durations from the jobs API, with the median. |
| `scripts/machine-class.sh` | iowait and steal of a run from boated-ci's machine samples: classifies the run as `fast` or `slow-io`. |
| `templates/cached-job.yml` | One job wired for Rust + Turbo + Docker (actionlint-clean). Start from it. |
| `references/*.md` | Details; each step below says which one to read. |

The scripts need bash, `jq` and `gh`; `mint-sandbox-key.sh` also needs `node`
and the engine checkout (`~/dev/ci-cache`, or `CI_CACHE_REPO`).

## The engine in one screen

- Worker: `https://ci-cache.omarespinosafernandez.workers.dev`. Repo
  `OmarAlex24/ci-cache` (private) at `~/dev/ci-cache`. Its README (Spanish)
  and `openapi.yaml` are the contract. API only: there is no dashboard.
- R2 bucket `ci-cache-weur` (Europe, next to Boat's OVH machines). Metrics go
  to Workers Analytics Engine.
- **Tiers.** The identity decides the tier. The client never chooses it.

  | Who | Tier | Reads | Writes |
  | --- | --- | --- | --- |
  | CI, `push` to main | `main` | `main/` | `main/` |
  | CI, pull request, or a push to another branch | `rama` | own branch, then `main/` | own branch |
  | CI, other event on main (schedule, dispatch) | `main-ro` | `main/` | nothing |
  | Sandbox key `sk_…` | always `rama` | own branch, then `main/` | own branch |

  An agent's mistake can never reach `main/`. Branches expire after 7 days
  and `main/` after 30, counted from upload.
- **Sessions:** `POST /v1/session` with a GitHub OIDC token (audience
  `ci-cache`) or a sandbox key. It returns an HMAC session token valid for 6 h.
- **Protocols:** Turbo at `/v8/artifacts`, WebDAV at `/dav/` for sccache.
  Stats at `/v1/stats` and `/v1/stats/branches` take an `rk_…` key.
- **CI side:** the `OmarAlex24/ci-cache/setup@<sha>` action. Sandbox side:
  `scripts/ci-cache-env.sh`.

Full detail, with inputs, outputs and every exported variable:
`references/engine.md`.

## Hard rules

1. **Never print a secret.** Sandbox keys (`sk_`), stats keys (`rk_`) and
   session tokens never go to a terminal, a log, a PR or this skill.
   - Never run `boat env info` or `boat env list`: they print variable
     values. A key leaked twice this way and had to be rotated.
   - Set variables with `boat env set-var <env> NAME`, reading the value
     from stdin.
   - In traces, test a secret with `${VAR:+set}`, never with its value.
2. **A cache never turns a job red.** Every cache step gets
   `continue-on-error: true`. Every cached path has an uncached fallback: a
   Docker build retries without the cache, and sccache stays off if it
   can't start. A cache problem makes a run slower, never red.
3. **Writes to shared infrastructure need Omar's OK.** That covers
   `wrangler secret put`, `wrangler deploy` and `gh cache delete`. Print the
   target, show the command, and wait for his answer.
4. **Every push costs a Boat start.** In a stack of N PRs, a push to the base
   costs N. Push only the top branch. Put temporary measurement code in a
   commit that a later commit reverts, because force-push may be blocked.

## What caches what

| Stack | Cache | Where it lives | Reference |
| --- | --- | --- | --- |
| Rust | sccache (`RUSTC_WRAPPER`) through ci-cache `/dav/` | R2 tiers | `references/rust.md` |
| Rust deps sources | `Swatinem/rust-cache`, **`~/.cargo` only** | Actions cache | `references/rust.md` |
| Turbo (TS/JS) | Turbo remote cache through ci-cache `/v8/` | R2 tiers | `references/turbo.md` |
| Docker images | BuildKit `type=gha`, `mode=max` | Actions cache | `references/docker.md` |
| Go | nothing in ci-cache yet (v2: `GOCACHEPROG`); keep `setup-go`'s cache | Actions cache | `references/roadmap.md` |
| pnpm store | no help under the bind mount (EXDEV) | — | `references/turbo.md` |

## Playbook

Work in this order. Make each stack its own PR, and measure between PRs.

### 1. Audit
Run `bash scripts/audit-cache.sh <repo-dir> <owner/repo>`. Note:
- the stacks present;
- every cache step, and where it sits relative to the toolchain steps;
- Vercel `TURBO_TOKEN`/`TURBO_TEAM`;
- `docker build` calls;
- the Actions cache size. Over ~8 GB, GitHub starts evicting what you are
  about to add. Propose deleting stale prefixes, but only with Omar's OK.

Also check two blockers:
- **Owner.** The repo must belong to an owner in the Worker's
  `ALLOWED_OWNERS` (`OmarAlex24`). An org repo needs an engine change first.
- **Fork PRs.** They get no OIDC token, so they run uncached.

→ `references/engine.md`.

### 2. Keys
A repo needs a sandbox key only if agents build it in Boat sandboxes. Mint
it with `scripts/mint-sandbox-key.sh <owner/repo>`. The script stores the
plaintext in `~/.config/ci-cache/keys.env` (mode 600) and merges the hash
into `sandbox_keys.json`. It prints only names and the next commands.

`wrangler secret put SANDBOX_KEYS` **replaces the whole map**: upload the
merged file, never a lone entry. → `references/keys.md`.

### 3. CI wiring
Put the action early, before rust-cache. Give the job
`permissions: id-token: write`.

```yaml
      - id: cache
        continue-on-error: true            # a cache problem is a slow run, not a red one
        uses: OmarAlex24/ci-cache/setup@c8972d60665c09e92455a710e406308f9e1bcbbd
        with:
          url: https://ci-cache.omarespinosafernandez.workers.dev
          mount-workdir: "true"            # Rust: build at /home/user/<repo>, like the sandboxes
```

Then follow the guide for each stack:
- **Rust** (`references/rust.md`):
  - export `CI_WORKDIR` from `steps.cache.outputs.workdir`, and make every
    task `cd "${CI_WORKDIR:-$GITHUB_WORKSPACE}"`;
  - put rust-cache after the action, with `cache-targets: false` and a new
    `prefix-key`;
  - pin the toolchain;
  - set `SCCACHE_IDLE_TIMEOUT: "0"` and add a stats step at the end.
- **Turbo** (`references/turbo.md`): delete the Vercel `TURBO_TOKEN` and
  `TURBO_TEAM` from `env:`, check that `TURBO_API` points at the Worker, and
  check `turbo.json`'s env and signature settings.
- **Docker** (`references/docker.md`):
  - export the cache runtime with `actions/github-script`;
  - build with `type=gha` (`mode=max`), and retry once without the cache;
  - reuse a binary that is already built, with `--build-context`;
  - keep CI-only files out of the context with `.dockerignore`.

`templates/cached-job.yml` puts all three together.

### 4. Sandbox wiring
In the repo's Boat environment, set `CI_CACHE_URL` and `CI_CACHE_SANDBOX_KEY`
(the key from stdin). Copy the CI values of every variable that enters the
keys, for example `RUSTFLAGS` and `CARGO_TERM_COLOR`. Install the same
sccache (0.19.0). In the sandbox, run `bash ci-cache-env.sh` and then
`source ~/.ci-cache.env`. Run it again after each branch switch, and once the
6 h token expires. → `references/sandbox.md`.

### 5. Verify
- Run `scripts/fingerprint-diff.sh` on a sandbox fingerprint and a CI run.
  Every line it flags as `KEY` is a reason to miss.
- Check the bind mount with `stat -c '%d:%i'`.
- Look at `sccache --show-stats` in the job summary.
- Read `scripts/cache-stats.sh <owner/repo>`: per branch,
  `ciHitsOnSandboxObjects / sandboxWrites`.

→ `references/rust.md` (parity), `references/measurement.md` (stats).

### 6. Measure
1. The first `main` run after onboarding is cold, and it fills `main/`.
   Don't judge on it.
2. Compare job durations with `scripts/job-durations.sh`: first attempts
   only, 5 or more runs per variant.
3. Classify each run's Boat machine with `scripts/machine-class.sh`, and
   compare only within a class.

→ `references/measurement.md`, `references/case-study.md`.

## Verification checklist

- [ ] `actionlint` is clean, and every cache step has `continue-on-error`.
- [ ] The job log shows `ci-cache: sesión <tier>` with the expected tier
      (`rama` on a PR, `main` on a push to main).
- [ ] Rust: `checkout: /home/user/<repo>` in the CI fingerprint. The
      `target/` saved and the one built have the same `device:inode`.
      `fingerprint-diff.sh` flags no `KEY` lines against a sandbox.
- [ ] Rust: rust-cache comes after the action, with `cache-targets: false`
      and a `prefix-key` that no old entry shares.
- [ ] Turbo: a step after the action prints `TURBO_API` as the Worker URL.
      No Vercel token is left in `env:`.
- [ ] Docker: a warm run shows the image stages `CACHED`. A build with a
      broken cache still ends green (retried without the cache).
- [ ] A second PR run after a warm `main` has a Rust hit rate above ~95 %
      in `sccache --show-stats`.
- [ ] Sandbox→PR: after a sandbox build on the PR's branch,
      `/v1/stats/branches` shows `ciHitsOnSandboxObjects` close to
      `sandboxWrites`, and `reuseAlert: false`.
- [ ] Job median over 5 or more first attempts, per machine class, is
      reported against the baseline.

## Pitfalls

- **Wrong path.** The Boat CI checkout is
  `$HOME/actions-runner/_work/<repo>/<repo>`, but sandboxes build in
  `/home/user/<repo>`. sccache hashes the cwd, so without the bind mount
  nothing is reused.
- **A `target/` restored from another path**, or one built without sccache,
  poisons the keys: sccache hashes `--extern` rlib content. Use
  `cache-targets: false` and bump `prefix-key`.
- **rust-cache before the action** doesn't put `RUSTC_WRAPPER` in its key.
  A run where the action failed then saves a `target/` that PRs restore.
- **Different environments.** Any difference in `RUSTFLAGS` or a `CARGO_*`
  variable (even `CARGO_TERM_COLOR`) between the sandbox and CI misses every
  crate. So does a floating `channel = "stable"` on a Rust release day.
- **Wrong branch.** The sandbox session is per branch. A sandbox on a
  differently named branch, or a stale `~/.ci-cache.env` after
  `git switch`, writes where the PR never reads.
- **Not rebased.** PR CI compiles the merge with main. Rebase right before
  the sandbox's final build, or the crates that main changed will miss.
- **Misreading `reuseAlert`.** It stays false below 20 sandbox writes, and
  it is also true on branches that CI never read (`no-ci` in
  `cache-stats.sh`). Read the ratio, not only the flag.
- **`ignore-error=true` on `--cache-to` covers only the export.** A cache
  that can't be set up or read still fails the build, so retry without it.
- **One `target/` lock serializes cargo tasks.** Grep the logs for
  `Blocking waiting for file lock on build directory`.
- **Restoring large caches before the tasks start delays all of them.**
  Restoring ~890 MB of `target/` cost ~60 s and made the job slower.
- **Comparing runs across machine classes.** iowait around 2 % versus
  15–23 % dominates the variance.

## Rollback

- Remove the action step, or set `sccache: "false"` (Turbo then still uses
  the cache). The job falls back to local builds.
- rust-cache with a new `prefix-key` leaves the old entries in place for
  7 days. Reverting restores them.
- Docker: drop the `--cache-from`/`--cache-to` flags. The retry path is
  already the uncached build.
- A leaked key: mint a new one, upload the merged map without the old hash,
  and update the Boat environment. → `references/keys.md`.

## Not built yet

- Replay of Rust test results (a design exists).
- A fingerprint diff that explains a miss on the server side.
- Go through `GOCACHEPROG`.
- Temporary Docker credentials.
- Sandbox tokens bound to one branch.

Turbo already replays task outputs, test logs included, across the same
tiers. → `references/roadmap.md`.
