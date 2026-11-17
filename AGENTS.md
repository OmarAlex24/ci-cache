# AGENTS.md

ci-cache is a Cloudflare Worker (Hono) on R2 that serves a Turbo remote cache
(`/v8/artifacts`) and an sccache WebDAV backend (`/dav/`) per repository. A `main/` tier is
written only by CI on main, and per-branch tiers are written by Boat sandboxes (`sk_` keys)
and by PR CI (GitHub OIDC). Metrics are a read-only JSON API (`/v1/stats*`, `rk_` keys,
[`openapi.yaml`](openapi.yaml)). The details are in [`README.md`](README.md).

## Layout

| Path | What lives there |
| --- | --- |
| `src/app.ts` | Hono app: mounts every route module, error handler |
| `src/session/` | `POST /v1/session`: OIDC verification, `sk_` keys, the tier policy (`policy.ts`), HMAC session tokens, `requireSession` |
| `src/turbo/`, `src/dav/` | the two cache protocols |
| `src/ratelimit.ts` | per-IP rate limit on requests without a valid credential (`BAD_CREDENTIAL_LIMITER`); valid credentials never reach it |
| `src/storage/tiers.ts` | tier → R2 read/write prefixes (`main/…`, `ramas/…`), including where fingerprints live |
| `src/fingerprint/` | `PUT`/`GET /v1/fingerprint`: sandbox and CI cache fingerprints, compared by the action |
| `src/metrics/record.ts` | one Analytics Engine data point per cache request |
| `src/stats/` | `/v1/stats`, `/v1/stats/branches`, `/v1/stats/repos` (AE SQL API) |
| `setup/` | the composite GitHub Action (`action.yml` + `setup.sh` + `fingerprint-compare.sh`) |
| `report/` | the report action (`action.yml` + `report.sh`): a job summary table at the end of the job |
| `scripts/` | `bootstrap.sh` (deploy your own instance), `ci-cache-env.sh` (sandbox side), `cache-fingerprint.sh`, `fingerprint-diff.sh` (the skill keeps an identical copy), `new-key.mjs`, `mint-session.mjs`, `e2e/` |
| `test/` | vitest in the Workers runtime (`@cloudflare/vitest-pool-workers`) |
| `skill/ci-cache/` | Claude Code skill that onboards other repos onto this engine |
| `openapi.yaml` | the API contract; keep it in sync with `src/` |

## Commands

```sh
pnpm install
cp .dev.vars.example .dev.vars   # once; e2e needs a SESSION_SECRET in it
pnpm check                       # typecheck + oxlint + vitest
pnpm e2e                         # real turbo, sccache, ci-cache-env.sh and setup.sh against wrangler dev
pnpm lint:openapi                # redocly lint of openapi.yaml
pnpm lint:sh                     # shellcheck of the client scripts
```

Never run `pnpm run deploy`, `scripts/bootstrap.sh` (without `--dry-run`), `wrangler secret
put` or `wrangler r2 …` against a real account unless the owner asks for it: they write to
production. `pnpm e2e:bootstrap` tests the bootstrap with a fake `wrangler`.

## Invariants (do not break)

- **The client never picks its tier.** The tier follows only from the verified identity
  (`src/session/policy.ts`). No request field, header or query parameter may choose or
  upgrade it.
- **`main/` is written only by CI on main**: an OIDC token whose event is in
  `MAIN_WRITE_EVENTS` on a ref in `MAIN_REFS`. Sandbox keys are always the branch tier,
  even on a branch named `main`; `main-ro` never writes.
- **Wire values are fixed.** The branch tier's wire value is `rama`, its R2 prefix is
  `ramas/`, its lifecycle rule is `ramas-7d`, and the SQL filters on `'rama'`. The action's
  input and output names and every env var name (`TURBO_*`, `SCCACHE_WEBDAV_*`,
  `CI_CACHE_*`) are part of the contract too. Renaming any of them orphans stored objects or
  breaks existing clients.
- **Tokens and keys are never logged**: not session tokens, `sk_`, `rk_`, OIDC tokens nor
  `SESSION_SECRET`. Not in Worker errors, scripts, tests' output, PRs or commits. Errors are
  generic JSON. Cache fingerprints are uploaded, so `cache-fingerprint.sh` must keep
  filtering secrets out.
- **Fail loudly, degrade at the caller.** `setup.sh` and `ci-cache-env.sh` exit non-zero
  with a clear message when they can't get a session (no OIDC permission, 401, Worker down);
  keep it that way. Only an sccache server that won't start degrades inside the action (a
  warning, no `RUSTC_WRAPPER`). Workflows put `continue-on-error: true` on the action step,
  so a cache problem makes a run slower, never red.

## Connecting a repo to ci-cache

**CI** (GitHub Actions). The job needs `id-token: write`. Put the action before any
`Swatinem/rust-cache` step:

```yaml
permissions:
  contents: read
  id-token: write
jobs:
  ci:
    runs-on: boat-large                    # or any Linux runner
    steps:
      - uses: actions/checkout@v5
      - id: cache
        continue-on-error: true            # a cache problem is a slower run, never a red one
        uses: OmarAlex24/ci-cache/setup@<sha>   # pin a full commit SHA
        with:
          url: ${{ secrets.CI_CACHE_URL }}    # a secret, not a variable: GitHub masks it in logs
          # mount-workdir: auto (default): with a Cargo.toml, build at /home/user/<repo> like sandboxes
      - working-directory: ${{ steps.cache.outputs.workdir || github.workspace }}
        run: |
          pnpm turbo run build test
          cargo build --locked
      - if: always()                       # job summary: hits, misses, fingerprint check
        continue-on-error: true
        uses: OmarAlex24/ci-cache/report@<sha>  # the same SHA as setup
```

The repo's owner must be in the Worker's `ALLOWED_OWNERS`, or `/v1/session` answers 403.
`CI_CACHE_URL` is an Actions **secret**, not a variable: GitHub masks it in logs, so the
Worker's URL never shows up in a public repo's runs (the action also `::add-mask::`s it).

**Sandbox** (Boat, or any shell with an `sk_` key). Mint a key with
`node scripts/new-key.mjs sandbox <repoId> <owner/repo> boat` (it prints the key once: run it
where nobody reads the terminal, or use `skill/ci-cache/scripts/mint-sandbox-key.sh`), merge
the hash entry into `SANDBOX_KEYS`, and give the sandbox `CI_CACHE_URL` and
`CI_CACHE_SANDBOX_KEY`. Then, in the repo, on the PR's branch:

```sh
# scripts/ci-cache-env.sh from this repo, delivered into the sandbox (the skill puts it at ~/.ci-cache/)
bash ~/.ci-cache/ci-cache-env.sh && source ~/.ci-cache.env   # again after every git switch and every 6 h
```

**Exported variables** (by the action to `$GITHUB_ENV`, by `ci-cache-env.sh` to
`~/.ci-cache.env`):
- `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` (plus `TURBO_CACHE=local:rw,remote:r` on
  `main-ro`);
- with Rust: `RUSTC_WRAPPER=sccache`, `SCCACHE_WEBDAV_ENDPOINT`, `SCCACHE_WEBDAV_TOKEN`,
  `SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true`, `CARGO_INCREMENTAL=0`;
- `TURBO_RUN_SUMMARY=true` (for the report action; not if the job sets it);
- action outputs: `tier`, `branch`, `expires-at`, `workdir`, `fingerprint-compare`.

**Check that it hits:**
- the action logs `ci-cache: session <tier> (branch <branch>) until <expiry>`: `rama` on a
  PR, `main` on a push to main;
- `sccache --show-stats`: Rust hit rate above ~95 % on a warm PR;
- turbo prints `cache hit, replaying logs` per task;
- `GET /v1/stats/branches?repo=<repoId>` with an `rk_` key: `ciHitsOnSandboxObjects` close
  to `sandboxWrites` and `reuseAlert: false` after a sandbox build on the PR's branch;
- on a branch, the action compares CI's cache fingerprint with the one the sandbox uploaded:
  every `ci-cache cache key mismatch` warning (and row in the job summary) is a reason to
  miss. By hand: `bash scripts/cache-fingerprint.sh > sandbox.txt` in the sandbox,
  `gh run view <id> --log > ci.log`, then `bash scripts/fingerprint-diff.sh sandbox.txt ci.log`
  (every `KEY` line is a reason to miss).

The [`skill/ci-cache`](skill/ci-cache) skill does all of this step by step (audit, keys,
Rust/Turbo/Docker wiring, Boat environments, measurement). Its scripts read `CI_CACHE_URL`,
`CI_CACHE_REPO` and `CI_CACHE_ALLOWED_OWNERS`.
