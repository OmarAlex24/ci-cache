# The engine: what exists and what it exports

The contract is the engine repo (`OmarAlex24/ci-cache`, or your fork,
checked out at `CI_CACHE_REPO`). Read its `README.md` and `openapi.yaml`
when this page and the code disagree. The code wins.

## Contents
- Endpoints
- Tiers and identities
- The setup action (CI side)
- The sandbox script
- Keys and secrets the Worker holds
- Limits and failure modes
- Who can use it

## Endpoints

Base URL: your deployment (`scripts/bootstrap.sh` prints it). The skill's
scripts read it from `CI_CACHE_URL`; workflows read it from the Actions
**secret** `CI_CACHE_URL` (a secret, not a variable, so GitHub masks it in
logs).

| Endpoint | Credential | What it does |
| --- | --- | --- |
| `GET /health` | none | liveness check |
| `POST /v1/session` | GitHub OIDC (audience `ci-cache`) or `sk_…` with `{"branch": "<name>"}` | issues the session token (6 h): `token`, `expiresAt`, `repoId`, `repo`, `tier`, `branch`, `kind`; 403 for a key bound to `branches` patterns the branch doesn't match |
| `GET /v8/artifacts/status` | session | `{"status":"enabled"}` |
| `GET`/`HEAD`/`PUT /v8/artifacts/{hash}` | session | Turbo artifacts |
| `POST /v8/artifacts` | session | batch lookup (up to 1000 hashes) |
| `POST /v8/artifacts/events` | session | Turbo events (validated, then dropped) |
| `GET`/`PUT`/`PROPFIND /dav/…` | session | WebDAV for sccache (PROPFIND only with `Depth: 0`) |
| `PUT /v1/fingerprint` | session | stores the session's cache fingerprint (text, ≤ 64 KB) under its own tier; `main-ro` gets 403 |
| `GET /v1/fingerprint` | session | the counterpart: branch CI → its branch's sandbox fingerprint; sandbox → its branch's CI fingerprint, else main's; 404 if none |
| `GET /v1/stats?repo=<id>&range=<r>` | `rk_…` | hits, misses, bytes and time saved, totals plus `byTier`, `byKind`, `byProtocol` |
| `GET /v1/stats/branches?repo=<id>&range=<r>` | `rk_…` | per branch: `sandboxWrites`, `ciReads`, `ciHits`, `ciHitsOnSandboxObjects`, `reuseAlert` |
| `GET /v1/stats/repos?range=<r>` | `rk_…` | the repos with traffic in the range: `repoId`, `repo`, `lastSeenAt`, `totals`, `reuseAlerts` |

- `repo` is the **numeric** GitHub repository id:
  `gh api repos/O/R --jq .id`.
- `range` is one of `1h`, `24h`, `7d` (the default), `30d` or `90d`.
  Analytics Engine keeps data for 3 months.
- A request **without a valid credential** (bad or missing Bearer, a failed
  session, a bad `rk_`) counts against a per-IP limit (30 per 60 s by
  default); past it, failures get `429 rate_limited`. Valid credentials are
  never limited, so shared CI runner IPs are safe.
- Every response carries `Server-Timing`: `session`, `r2-own`, `r2-main`,
  `r2-put` and `total`. To split network time from Worker time and R2 time,
  run `curl -w '%{time_starttransfer} %header{server-timing}'`.

## Tiers and identities

The R2 layout is `main/<repoId>/{turbo,sccache}/…` and
`ramas/<repoId>/<branchKey>/{turbo,sccache}/…`, where `branchKey` is the
first 16 hex characters of `sha256(branch)`. Fingerprints live at
`ramas/<repoId>/<branchKey>/fingerprint/<sandbox|ci>` and
`main/<repoId>/fingerprint/ci`.

The Worker decides the tier in this order (`src/session/policy.ts`):

1. An event in `MAIN_WRITE_EVENTS` (`push`) on a ref in `MAIN_REFS` (`main`
   or `master`) → `main`.
2. An OIDC token with a `head_ref` (`pull_request`, `pull_request_target`)
   → `rama`, on branch `head_ref`.
3. Any other event on a main ref (`schedule`, `workflow_dispatch`) →
   `main-ro`. It reads `main/` and every write gets a 403.
4. Any other ref (a push to a branch, a tag) → `rama`, on the ref name.

A sandbox key is **always** `rama`, even on a branch named `main`.

So a PR and a sandbox share objects only when **the sandbox's branch name
equals the PR's head branch name**. Reads fall back to `main/`. A branch
read fetches its own prefix and `main/` concurrently, and keeps the first
one that exists.

Metrics give each read one of these results: `hit` (own prefix),
`hit-main` (a branch served from `main/`), `miss` or `write`. Each object
records who wrote it (`writer-kind`: `ci` or `sandbox`), and that is how
`ciHitsOnSandboxObjects` is computed.

## The setup action (CI side)

`OmarAlex24/ci-cache/setup@<sha>` (or `<your-fork>/ci-cache/setup@<sha>`).
Pin a full commit SHA from the engine repo. It is a composite action that
runs `setup/setup.sh`, then `scripts/cache-fingerprint.sh`, then
`setup/fingerprint-compare.sh` (in the `workdir`, with the session's
exports). It masks the Worker URL and its host with `::add-mask::`.

The job needs `permissions: id-token: write`. Without it, the action fails
with "no OIDC token".

**Inputs**

| Input | Default | Meaning |
| --- | --- | --- |
| `url` | required | Worker URL, no trailing slash |
| `audience` | `ci-cache` | OIDC audience; must equal the Worker's `CACHE_AUDIENCE` |
| `sccache` | `auto` | `auto` installs it if a `Cargo.toml` is found within depth 3 (outside `node_modules` and `target`); `true` or `false` force it |
| `sccache-version` | `0.19.0` | any other version needs `sccache-sha256` |
| `sccache-sha256` | pinned for 0.19.0 (x86_64, aarch64) | tarball SHA-256 |
| `mount-workdir` | `auto` | `sudo mount --bind $GITHUB_WORKSPACE /home/user/<repo>`. `auto`: only with a `Cargo.toml`, on Linux, with passwordless sudo; otherwise (or if the target isn't empty, or the mount fails) a log line and no mount. `"true"`: mount or fail. `"false"`: never |
| `fingerprint` | `"true"` | prints the cache fingerprint after the session |
| `fingerprint-compare` | `"true"` | uploads CI's fingerprint and, on the branch tier, compares it with the sandbox's: one `::warning` per differing key line, plus a job summary table |
| `turbo-summary` | `"true"` | exports `TURBO_RUN_SUMMARY=true` (unless the job sets it) so the report action can count Turbo hits |

**Outputs:** `tier`, `branch`, `expires-at`, `workdir` and
`fingerprint-compare` (`match`, `mismatch`, `none`, `skipped`, `error`).
`workdir` is `/home/user/<repo>` with the mount, otherwise `GITHUB_WORKSPACE`.

**Report action** (`OmarAlex24/ci-cache/report@<sha>`): last step of the job,
with `if: always()` and `continue-on-error: true`. It writes a table to the
job summary: tier and branch, sccache hits/misses and hit rate (plus an
estimate of the compile time saved, with 10 or more compilations to average),
Turbo tasks from cache and their task time saved (from `.turbo/runs/*.json`,
written thanks to `TURBO_RUN_SUMMARY`), and the fingerprint comparison. It
never fails the job.

**Exported to `$GITHUB_ENV`**

- Always: `TURBO_API` (the Worker URL), `TURBO_TOKEN` (the session token,
  masked) and `TURBO_TEAM` (the repo name; turbo requires a team and the
  Worker ignores it).
- On `main-ro` only: `TURBO_CACHE=local:rw,remote:r`. A 403 makes turbo turn
  off the remote cache for the rest of the run.
- With sccache, **only if `sccache --start-server` works against the Worker**:
  `RUSTC_WRAPPER=sccache`, `SCCACHE_WEBDAV_ENDPOINT=<url>/dav`,
  `SCCACHE_WEBDAV_TOKEN`, `SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true` and
  `CARGO_INCREMENTAL=0`. If the server fails to start, the action emits a
  `::warning::` and the run compiles without sccache.
- It adds the sccache directory to `$GITHUB_PATH`.
- `TURBO_RUN_SUMMARY=true`, unless the job sets it (`turbo-summary`), for
  the report action.

The action does **not** export `CI_WORKDIR`. Workflows export it themselves
from `steps.<id>.outputs.workdir` (see `rust.md`).

The log prints `ci-cache: session <tier> (branch <branch>) until <expiry>`.
Use that line to check the tier.

## The sandbox script

`scripts/ci-cache-env.sh` in the engine repo. Inputs are `CI_CACHE_URL` and
`CI_CACHE_SANDBOX_KEY` (it must start with `sk_`). Two optional variables
change its defaults:
- `CI_CACHE_BRANCH`: the branch to use. The default is the current git
  branch, and the script fails on a detached HEAD.
- `CI_CACHE_ENV_FILE`: where to write. The default is `~/.ci-cache.env`.

It sends the key through stdin (`-H @-`), so the key never shows in `ps`.

It writes `~/.ci-cache.env` (mode 600) with these exports:
- `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM`;
- `SCCACHE_WEBDAV_ENDPOINT`, `SCCACHE_WEBDAV_TOKEN`,
  `SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true`;
- `CARGO_INCREMENTAL=0`;
- `RUSTC_WRAPPER=sccache`, only if `sccache` is on `PATH`.

Then it stops the sccache server, so the next build picks up the new token,
and uploads the checkout's cache fingerprint (`cache-fingerprint.sh` must
sit next to it, or `CI_CACHE_FINGERPRINT_SCRIPT`; `CI_CACHE_FINGERPRINT=false`
skips it). A failed upload is only a warning. It never prints the key or
the token, and refuses to upload a fingerprint that contains either.

## Keys and secrets the Worker holds

| Secret | Content |
| --- | --- |
| `SESSION_SECRET` | HMAC key for session tokens |
| `SANDBOX_KEYS` | JSON `{"<sha256 of sk_ key>": {"repoId", "repo", "label", "branches"?}}`: **every** repo's entries (`branches`: optional patterns, `keys.md`) |
| `STATS_KEYS` | JSON `{"<sha256 of rk_ key>": {"label", "repoIds"?}}` |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Analytics Engine SQL API |

`node scripts/new-key.mjs sandbox <repoId> <owner/repo> [label]` and
`node scripts/new-key.mjs stats <label> [repoId,…]` print the key **once**,
followed by the hash entry. Don't run them in a terminal someone else
reads: use `scripts/mint-sandbox-key.sh` from this skill (see `keys.md`).

## Limits and failure modes

- **100 MB per object** (the Worker's body limit). Turbo skips a bigger
  artifact and goes on.
- A `PUT` needs `Content-Length`, or it gets a 411.
- Turbo hashes are 1–128 hex characters. sccache path segments are
  `[A-Za-z0-9._-]`, at most 512 characters in total.
- R2 lifecycle counts from **upload**, not last use. A hot `main/` object
  still disappears at 30 days: the next main run misses it once and writes
  it again.
- If the Worker is down when the session is requested, the action step
  fails. `continue-on-error` turns that into an uncached run.
- If the Worker fails between the session and the first rustc, the
  sccache server is already up (the action started it). Each later failed
  read counts as a miss and compiles locally.

## Who can use it

- `ALLOWED_OWNERS` (in `wrangler.jsonc`, or `--allowed-owners` of
  `scripts/bootstrap.sh`, which deploys it as a `--var`) is a comma-separated list of
  GitHub users or orgs, compared case-insensitively. A repository owned by
  anyone else gets a 403 from `/v1/session` until that list is edited and
  the Worker redeployed, which needs the engine owner's OK.
- **Fork PRs** get no OIDC token. Gate the job on same-repo PRs, or accept
  that those runs are uncached:

  ```yaml
  if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
  ```
- The action is a composite action in the engine repo, so any repo can
  reference it while that repo is public. A fork points `uses:` at its own
  copy (`<your-fork>/ci-cache/setup@<sha>`). If the engine repo is private,
  other repos can use the action only when its Actions access setting
  allows them (`gh api repos/<owner>/ci-cache/actions/permissions/access`).
  A job that fails at "Set up job" with "unable to resolve action" points
  at that setting or at a wrong pin.
