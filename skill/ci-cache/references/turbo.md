# Turbo (and pnpm) through ci-cache

The Worker implements Turbo's Remote Cache API v8 at `/v8/artifacts`, with
the same tiers as sccache. Turbo replays task **outputs and logs** on a
hit, so cached `test` tasks are skipped as well, as long as their inputs and
env hash the same.

## Contents
- CI wiring
- Remove Vercel's cache
- turbo.json settings that decide reuse
- Sandbox wiring
- Checking hash parity
- pnpm under the bind mount
- Failure modes

## CI wiring

The setup action exports `TURBO_API`, `TURBO_TOKEN` and `TURBO_TEAM` to
`$GITHUB_ENV`. Nothing else is needed: `turbo` reads them from the
environment.

```yaml
      - name: ci-cache
        id: cache
        continue-on-error: true
        uses: OmarAlex24/ci-cache/setup@<sha>   # pin a full commit SHA
        with:
          url: ${{ vars.CI_CACHE_URL }}      # https://ci-cache.<your-subdomain>.workers.dev
          sccache: "false"          # a TS-only repo; omit to auto-detect Rust
      - name: ci-cache check
        continue-on-error: true
        run: |
          echo "TURBO_API=${TURBO_API:-unset}"           # the URL is not secret
          echo "TURBO_TOKEN=${TURBO_TOKEN:+set}"          # never the value
          echo "TURBO_TEAM=${TURBO_TEAM:-unset}"
      - run: pnpm turbo run build lint test
```

`mount-workdir` is only needed for sccache. Turbo hashes paths relative to
the repo root, so the checkout path doesn't change its keys. Without a
`Cargo.toml`, the default `mount-workdir: auto` doesn't mount, which also
avoids the pnpm problem below.

## Remove Vercel's cache

Many repos set the Vercel remote cache in `env:`:

```yaml
env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}
```

Delete those lines (and propose deleting the secret afterwards). Two
reasons:
- one cache is enough, and two tokens make it unclear which one served a
  hit;
- an explicit `env:` on the job or step can **shadow** what the action
  wrote to `$GITHUB_ENV`. Don't assume the precedence: the check step
  above shows which `TURBO_API` won.

Also drop `TURBO_REMOTE_ONLY`, `--remote-only` and `--api`/`--token`/`--team`
flags in scripts, and any `.turbo/config.json` committed with a team id.

A local cache restored with `actions/cache` (`.turbo/cache`, or a
`TURBO_CACHE_DIR`) can stay as a first level, but
it's redundant once the remote cache is warm. Measure before keeping it,
since it costs Actions cache space.

## turbo.json settings that decide reuse

Turbo's hash includes the task's inputs, its dependencies' hashes, the
global and task `env` values, and lockfile entries. For a sandbox build to
be reused by CI:
- **`env` / `globalEnv`**: every variable listed must have the same value
  in the sandbox and in CI. Don't list `CI`, `GITHUB_*` or anything
  run-specific. Use `passThroughEnv` for variables a task needs that
  shouldn't change its hash.
- **Strict env mode** (the default in Turbo 2) hides unlisted variables
  from tasks. That's good for parity. A task that fails in CI with a missing
  variable needs it in `env` or `passThroughEnv`.
- **`remoteCache.signature: true`**: both sides need the same
  `TURBO_REMOTE_CACHE_SIGNATURE_KEY`, or every read fails verification.
  Avoid it unless the repo already uses it. The tiers already keep sandbox
  writes out of `main/`.
- **Outputs**: `outputs` must list everything later tasks read. A missing
  output is a hit that restores nothing.
- Pin `turbo` in `package.json`, so both sides compute hashes with the same
  version.

## Sandbox wiring

`ci-cache-env.sh` writes the same three variables to `~/.ci-cache.env`. In
the sandbox, after `source ~/.ci-cache.env`, `pnpm turbo run build` reads
and writes the branch tier. See `sandbox.md`.

## Checking hash parity

```bash
pnpm turbo run build --dry=json > dry.json
jq -r '.tasks[] | "\(.taskId) \(.hash)"' dry.json | sort
```

Run this in the sandbox and in a CI step on the same commit, then diff. For
a task whose hashes differ, compare `.tasks[].environmentVariables` and
`.tasks[].inputs` between the two files. The difference is there.

Turbo's own summary (`--summarize`, written to `.turbo/runs/`) records the
cache source per task (`LOCAL`, `REMOTE`). Upload it as an artifact if you
need to show which tasks hit.

## pnpm under the bind mount

With the mount (`mount-workdir: auto` on a repo with Rust, or `"true"`), the checkout appears at both
`$GITHUB_WORKSPACE` and `/home/user/<repo>`. pnpm hard-links packages from
its store into `node_modules`. A store that `setup-node`'s `cache: pnpm`
restored on the other side of the mount fails with **EXDEV** (a cross-device
link), and pnpm downloads every package again:
- In the first rollout's repo: 298 packages, 1–5 s, so it didn't matter.
- Installing from `$GITHUB_WORKSPACE` reuses the store. But a later
  `pnpm build` from `/home/user/<repo>` sees another store and installs
  everything again.

Options, in order:
1. Accept it when the install is short, as it was there.
2. Point the store inside the mount (`pnpm config set store-dir
   /home/user/<repo>/.pnpm-store`), and cache that path. Measure: the
   restore is a foreground step.
3. Don't mount in a JS-only repo.

## Failure modes

- **403 on a write** makes turbo turn off the remote cache **for the rest of
  the run**. That's why the action sets `TURBO_CACHE=local:rw,remote:r` on
  `main-ro` (schedule and dispatch runs on main).
- **Artifacts over 100 MB** are refused (413). Turbo logs it and goes on
  without the cache for that task.
- **Worker down**: turbo warns and runs the tasks. The job stays green.
