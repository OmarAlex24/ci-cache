---
name: ci-cache
description: Onboard a repo onto a ci-cache engine (a Cloudflare Worker on R2 serving a Turbo remote cache and an sccache WebDAV backend; a main/ tier written only by CI on main, per-branch tiers shared by PR CI and agents' sandboxes from any provider) and get the most out of it. It audits stacks and caches, wires Rust (sccache, the build-path bind mount, rust-cache order), Turbo and Docker (BuildKit type=gha) into GitHub Actions, connects sandboxes (pinned installer, keys minted without printing them, a Boat recipe), checks sandbox vs CI cache-key parity, adds the job summary report, deploys an instance with bootstrap.sh, reads /v1/stats and measures the gain. Use it when the user mentions ci-cache, sccache or RUSTC_WRAPPER, a remote compile cache, Turbo remote cache or TURBO_TOKEN, Swatinem/rust-cache, Docker layer caching in CI, cache hit rate or misses, a sandbox build CI did not reuse, a cache key mismatch, reuseAlert, the 10 GB Actions cache limit, or making CI faster with caching, even if they never say ci-cache.
---

# CI cache (ci-cache engine)

**ci-cache** is a remote build cache for GitHub Actions that agents'
sandboxes can share. CI on a branch reuses what `main` built; an agent that
compiles in its sandbox (Boat, a container, a VM: any provider) warms its
PR's CI too. It caches *inside* jobs. On per-start runners such as Boat, the
`boated-ci` skill is its complement: it cuts the number of jobs (machine
starts). Use boated-ci to consolidate the jobs, then this skill to make the
one heavy job fast.

Paths below (`scripts/`, `templates/`, `references/`) are relative to this
skill's directory, wherever it is installed (as a plugin or under
`~/.claude/skills/`).

A cache only pays when the two sides produce **byte-identical cache keys**:
same path, toolchain, flags and environment. Most of this skill is about
getting that parity and proving it with numbers.

## Bundled resources

| Path | Use it for |
| --- | --- |
| `scripts/audit-cache.sh` | Stack detection, cache steps in the workflows, Actions cache usage vs the 10 GB limit. Run first. |
| `scripts/mint-sandbox-key.sh` | Mint a sandbox key (one per repo and label: a provider or machine pool) and merge it into the local key files without printing it. |
| `scripts/connect-sandbox.sh` | Boat only: wire a repo's Boat environment (both variables from stdin, `ci-cache-env.sh`, `cache-fingerprint.sh` and the sccache installer as secret files, `boat env upgrade`). Names only, `--dry-run`. Other providers use the engine's `scripts/install-sandbox.sh`. |
| `scripts/fingerprint-diff.sh` | Diff two cache fingerprints by hand; flags the lines that break keys. The setup action already does this on every branch-tier job. |
| `scripts/cache-stats.sh` | Read `/v1/stats` and `/v1/stats/branches` (sandbox→CI reuse per branch). |
| `scripts/job-durations.sh` | First-attempt job durations from the jobs API, with the median; `--compare <date or commit>` prints a before/after markdown table. Identical copy of the engine's. |
| `scripts/machine-class.sh` | iowait and steal of a run from boated-ci's machine samples: classifies the run as `fast` or `slow-io`. |
| `templates/cached-job.yml` | One job wired for Rust + Turbo + Docker (actionlint-clean). Start from it. |
| `templates/sandbox-install-sccache.sh` | Installs CI's sccache (0.19.0, SHA-256 checked) in a sandbox; `connect-sandbox.sh` delivers it, and the engine's `install-sandbox.sh --rust` fetches and runs it. |
| `references/*.md` | Details; each step below says which one to read. |

The scripts need bash, `jq` and `gh`; `mint-sandbox-key.sh` also needs `node`
and the engine checkout (`CI_CACHE_REPO`, or the clone this skill lives in;
installed as a plugin, the skill is a copy outside the clone, so set
`CI_CACHE_REPO`). Only `connect-sandbox.sh` needs the `boat` CLI.
Every script that calls the Worker reads its URL from `CI_CACHE_URL` and
fails if it is unset; `audit-cache.sh` checks the owner against
`CI_CACHE_ALLOWED_OWNERS` (or `--allowed-owners`).

## The engine in one screen

- Worker: your deployment (`CI_CACHE_URL`; in workflows the Actions
  **secret** `secrets.CI_CACHE_URL`, never a variable, so GitHub masks it).
  Engine repo `OmarAlex24/ci-cache`, or your fork, checked out at
  `CI_CACHE_REPO`. Its README and `openapi.yaml` are the contract. API only:
  there is no dashboard. No deployment yet? `bash scripts/bootstrap.sh
  --allowed-owners <owner> --dry-run` in the engine repo, then without
  `--dry-run` (with the owner's OK: it writes to their Cloudflare account).
- One R2 bucket (`bootstrap.sh` defaults to `ci-cache`; put it near whoever
  compiles with `--location`). Metrics go to Workers Analytics Engine.
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
- **Protocols:** Turbo at `/v8/artifacts`, WebDAV at `/dav/` for sccache,
  cache fingerprints at `/v1/fingerprint`. Stats at `/v1/stats` and
  `/v1/stats/branches` take an `rk_…` key. Bad credentials are rate limited
  per IP (429); valid ones never are.
- **CI side:** the `OmarAlex24/ci-cache/setup@v1` action (session,
  `mount-workdir: auto`, sccache, fingerprint comparison) and
  `OmarAlex24/ci-cache/report@v1` (job summary). Sandbox side:
  `scripts/ci-cache-env.sh` (session, then fingerprint upload; sourcing
  `~/.ci-cache.env` renews it), installed by `scripts/install-sandbox.sh`.

Full detail, with inputs, outputs and every exported variable:
`references/engine.md`.

## Hard rules

1. **Never print a secret.** Sandbox keys (`sk_`), stats keys (`rk_`) and
   session tokens never go to a terminal, a log, a PR or this skill.
   - Put a key into a provider's secret store from stdin, never as an
     argument, and filter the answer: many provider CLIs echo values back.
   - In Boat, `boat env info`, `boat env list` and the answer of
     `boat env new` print variable values. A key leaked twice this way and
     had to be rotated. Read them only as `--json` piped into a `jq` filter
     that emits names, then `sed`-redact `sk_`/`rk_`, and set variables with
     `boat env set-var <env> NAME` from stdin. `connect-sandbox.sh` does this
     for you.
   - In traces, test a secret with `${VAR:+set}`, never with its value.
2. **A cache never turns a job red.** Every cache step gets
   `continue-on-error: true`. Every cached path has an uncached fallback: a
   Docker build retries without the cache, and sccache stays off if it
   can't start. A cache problem makes a run slower, never red.
3. **Writes to shared infrastructure need the engine owner's OK.** That
   covers `scripts/bootstrap.sh` (without `--dry-run`), `wrangler secret
   put`, `wrangler deploy` and `gh cache delete`.
   Print the target, show the command, and wait for their answer.
4. **On per-start runners (Boat), every push costs a machine start.** In a
   stack of N PRs, a push to the base costs N. Push only the top branch. Put temporary measurement code in a
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
  about to add. Propose deleting stale prefixes, but only with the owner's OK.

Also check two blockers:
- **Owner.** The repo must belong to an owner in the Worker's
  `ALLOWED_OWNERS` (a comma-separated list in `wrangler.jsonc`). Another
  owner needs that list edited and the Worker redeployed first.
- **Fork PRs.** They get no OIDC token, so they run uncached.

→ `references/engine.md`.

### 2. Keys
A repo needs a sandbox key only if agents build it in sandboxes. Mint one
per provider (or machine pool) with
`scripts/mint-sandbox-key.sh <owner/repo> [label]`; `--branches 'agent/*'`
binds it to the branches the agents use (any other gets a 403). The script stores the
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
        uses: OmarAlex24/ci-cache/setup@v1   # or a full commit SHA
        with:
          url: ${{ secrets.CI_CACHE_URL }}      # a secret, not a variable: GitHub masks it in logs
          # mount-workdir: auto (default) builds Rust at /home/user/<repo>, like the sandboxes
          # workdir-path: <path>   # if your sandboxes clone the repo somewhere else
```

End the job with the report step, so every run shows its own numbers:

```yaml
      - if: always()
        continue-on-error: true
        uses: OmarAlex24/ci-cache/report@v1   # the same ref as setup
```

Then follow the guide for each stack:
- **Rust** (`references/rust.md`):
  - export `CI_WORKDIR` from `steps.cache.outputs.workdir`, and make every
    task `cd "${CI_WORKDIR:-$GITHUB_WORKSPACE}"`;
  - put rust-cache after the action, with `cache-targets: false` and a new
    `prefix-key`;
  - pin the toolchain to the release the runner image ships, and rename
    the image's `stable` to the pinned name before any rustup call;
  - set `SCCACHE_IDLE_TIMEOUT: "0"` and add a stats step at the end.
- **Turbo** (`references/turbo.md`): delete the Vercel `TURBO_TOKEN` and
  `TURBO_TEAM` from `env:`, check that `TURBO_API` points at the Worker, and
  check `turbo.json`'s env and signature settings.
- **Docker** (`references/docker.md`):
  - export the cache runtime with `actions/github-script`;
  - build with `type=gha` (`mode=max`), and retry once without the cache;
  - reuse a binary that is already built, with `--build-context`;
  - keep CI-only files out of the context with `.dockerignore`;
  - before narrowing a `COPY`, count the recompiles it would have saved,
    and prove that the new image equals the old one.

`templates/cached-job.yml` puts all three together.

### 4. Sandbox wiring
Skip this without agents' sandboxes. A sandbox writes to the cache only if
its agent opens a session; no provider runs it for you. Wire both ends:
1. **Secrets.** `CI_CACHE_URL` and `CI_CACHE_SANDBOX_KEY` (the label's key
   from step 2) in the provider's secret store, so every shell sees them.
2. **The client.** In the image or at boot, the engine's installer, pinned
   to a commit and SHA-256 checked (`--rust` also installs CI's sccache):
   ```bash
   ref=v1.0.0   # a release tag (immutable) or a full commit SHA
   curl -fsSL "https://raw.githubusercontent.com/OmarAlex24/ci-cache/$ref/scripts/install-sandbox.sh" |
     bash -s -- --ref "$ref" --rust
   ```
3. **The path.** sccache keys include it: the sandbox clones at
   `/home/user/<repo>`, or the CI step gets `workdir-path: <its path>`.
4. **Parity.** Copy the CI values of every variable that enters the keys
   into the sandbox's environment, for example `RUSTFLAGS` and
   `CARGO_TERM_COLOR`.
5. **The agent guide.** In the repo's `AGENTS.md`/`CLAUDE.md`, a few lines:
   - when `~/.ci-cache/` is present, run
     `bash ~/.ci-cache/ci-cache-env.sh && source ~/.ci-cache.env` on the
     PR's branch;
   - `source ~/.ci-cache.env` in every shell that builds (it renews the
     session after a `git switch` and before the 6 h expiry);
   - rebase onto `origin/main` before the final build.
6. **Verify with one sandbox**: build, rebuild after `cargo clean`, and read
   `/v1/stats/branches`.

**Boat recipe.** `scripts/connect-sandbox.sh <owner/repo> [env]
[--label L]`, first with `--dry-run`, does 1 and 2 for a Boat environment:
both variables from stdin, `~/.ci-cache/ci-cache-env.sh`,
`cache-fingerprint.sh` and `install-sccache.sh` as secret files, then
`boat env upgrade`. Boat clones at `/home/user/<repo>`, the action's
default. A repo without an environment needs `--create-env`; never use
`base` (CI runners start from it). Connecting a repo to sandboxes in Boat's
GitHub settings, so that `boat env add-repo` works, is the Boat account
owner's step. Other providers: the engine's `CONTRIBUTING.md` has a recipe
template. → `references/sandbox.md`.

### 5. Verify
- Read the PR run's `ci-cache cache key mismatch` warnings and the
  fingerprint table in the job summary: every row is a reason to miss.
  (By hand: `scripts/fingerprint-diff.sh` on a sandbox fingerprint and a CI
  log.)
- Check the bind mount with `stat -c '%d:%i'` (`mount-workdir: auto` logs
  why it skipped the mount, if it did).
- Read the report's table in the job summary: sccache hit rate and the
  estimated compile time saved, Turbo tasks from cache and their time saved,
  fingerprint result.
- Read `scripts/cache-stats.sh <owner/repo>`: per branch,
  `ciHitsOnSandboxObjects / sandboxWrites`.

→ `references/rust.md` (parity), `references/measurement.md` (stats).

### 6. Measure
1. The first `main` run after onboarding is cold, and it fills `main/`.
   Don't judge on it.
2. Compare job durations with `scripts/job-durations.sh`: first attempts
   only, 5 or more runs per variant. `--compare <commit>` (the onboarding
   commit) gives the before/after table to paste in the PR.
3. On Boat runners, classify each run's machine with
   `scripts/machine-class.sh`, and compare only within a class.

→ `references/measurement.md`, `references/case-study.md`.

## Verification checklist

- [ ] `actionlint` is clean, and every cache step has `continue-on-error`.
- [ ] The job log shows `ci-cache: session <tier>` with the expected tier
      (`rama` on a PR, `main` on a push to main).
- [ ] Rust: `checkout: /home/user/<repo>` in the CI fingerprint. The
      `target/` saved and the one built have the same `device:inode`.
      The action's fingerprint comparison says `match` (no
      `cache key mismatch` warning) after a sandbox build on the branch.
- [ ] The report step's table is in the job summary.
- [ ] The workflow reads `secrets.CI_CACHE_URL`, not `vars.CI_CACHE_URL`.
- [ ] Rust: rust-cache comes after the action, with `cache-targets: false`
      and a `prefix-key` that no old entry shares.
- [ ] Rust: the toolchain step logs `reused as <pin>-<host>` and rustup's
      `using existing install`, not a download.
- [ ] Turbo: a step after the action says `TURBO_API = the ci-cache Worker` (it compares
      with `secrets.CI_CACHE_URL` and never prints the URL).
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

- **Wrong path.** CI checks out under the runner's work directory, but
  sandboxes build where they clone (`/home/user/<repo>` in Boat). sccache
  hashes the cwd, so without the bind mount nothing is reused.
  `mount-workdir: auto` mounts at `workdir-path` (default
  `/home/user/<repo>`), but the build must run in
  `steps.<id>.outputs.workdir`.
- **A `target/` restored from another path**, or one built without sccache,
  poisons the keys: sccache hashes `--extern` rlib content. Use
  `cache-targets: false` and bump `prefix-key`.
- **rust-cache before the action** doesn't put `RUSTC_WRAPPER` in its key.
  A run where the action failed then saves a `target/` that PRs restore.
- **Different environments.** Any difference in `RUSTFLAGS` or a `CARGO_*`
  variable (even `CARGO_TERM_COLOR`) between the sandbox and CI misses every
  crate. So does a floating `channel = "stable"` on a Rust release day.
- **Pinning the image's own release still downloads it.** rustup knows
  toolchains only by name, so the image's `stable` isn't reused as
  `1.97.1`: 5.6–150 s per run on Boat. `rustup --version` already installs
  the pin, so rename before any rustup call (`rust.md`).
- **Wrong branch.** The sandbox session is per branch. A sandbox on a
  differently named branch writes where the PR never reads. Sourcing
  `~/.ci-cache.env` renews the session after a `git switch`; a shell that
  sourced it before the switch and never again still holds the old token.
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
- A leaked key: mint a new one (`--rotate`), upload the merged map without
  the old hash, and update the sandbox provider's secret.
  → `references/keys.md`.

## Not built yet

- A startup hook in sandboxes. Agents open the session because the repo's
  agent guide says so; nothing runs it for them.
- The toolchain rename in sandboxes. Each sandbox downloads the pinned
  release once; `ci-cache-env.sh` could rename the image's `stable` like
  CI does.
- Replay of Rust test results (a design exists).
- A fingerprint diff on the server side (`/v1/stats/branches` saying which
  input differed); today the action compares per run.
- Go through `GOCACHEPROG`.
- Temporary Docker credentials.

Turbo already replays task outputs, test logs included, across the same
tiers. → `references/roadmap.md`.
