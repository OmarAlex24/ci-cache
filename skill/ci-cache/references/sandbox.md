# Boat sandboxes: wiring the agent's side

The payoff of ci-cache is that the agent's own build in its Boat sandbox
warms the cache for its PR. This page is about that side.

## Contents
- What a Boat sandbox has
- Connecting a repo: connect-sandbox.sh
- Reading Boat environments without printing values
- Making agents use it: the repo's agent guide
- Per session: refresh, branch, rebase
- The sandbox → PR flow
- Verifying with one sandbox start
- What only Omar can do
- Never print secrets

## What a Boat sandbox has

Measured on 2026-11-09 (Boat CLI 1.0.92, a `default` sandbox):

- User **`user`**, `HOME=/home/user`, `WORK_DIR=/home/user`. Repos listed
  in the environment are cloned to **`/home/user/<repo>`**. Boat CI checks
  out to `$HOME/actions-runner/_work/<repo>/<repo>` instead, which is why CI
  bind-mounts to the sandbox path (`rust.md`).
- Variables only Boat sets: `BOAT_ID`, `BOX_ID`, `ENVIRONMENT_ID`,
  `MACHINE_ID`. `IS_SANDBOX` is set too, but the name is generic: other
  agent clouds may set it. Use `BOAT_ID` as the signal.
- The image has cargo and rustc (rustup's `stable`, in `/usr/local/cargo`),
  bun, pnpm, node, jq, curl, `sha256sum` and git. **It has no sccache.**
  `~/.local/bin` comes first on `PATH`.
- **No startup hook.** Nothing in an environment runs when a sandbox
  starts. `boat new --setup-file` runs a script, but it's a flag on one
  CLI create. Nobody has checked whether sandboxes started from the
  dashboard can get one. The repo's agent guide is the hook (below).
- Environment variables (`set-var`) reach every shell and `boat exec`.
- Secret files (`set-file <env> <path>`) land at `/home/user/<path>`. Boat
  creates the parent directories and writes the file **mode 644**, so run
  delivered scripts with `bash`.
- `boat env upgrade <env>` pushes the latest version to live sandboxes
  (`upgradedLive` in its answer). Stopped sandboxes pick it up at resume.
- A `set-var` or `set-file` with the value the version already has mints
  no new version, so re-running the connect script costs nothing.

## Connecting a repo: connect-sandbox.sh

```bash
bash ~/.claude/skills/ci-cache/scripts/connect-sandbox.sh OmarAlex24/<repo> [env] --dry-run
bash ~/.claude/skills/ci-cache/scripts/connect-sandbox.sh OmarAlex24/<repo> [env]
```

It does, in order:
1. **Find the environment.** Without `[env]`, it takes the one whose repos
   include `<owner/repo>`, and failing that, the one named like the repo. It
   refuses if several match. It never creates one unless you pass
   `--create-env`, and never touches `base`, the default environment that
   CI runners start from, unless you name it.
2. **Show the state by name**: version, variable names, secret file paths,
   repos, live sandboxes, and whether `CI_CACHE_URL` and
   `CI_CACHE_SANDBOX_KEY` are set.
3. **Set both variables** through stdin. The key comes from
   `CI_CACHE_SANDBOX_KEY_<REPO>` in `~/.config/ci-cache/keys.env`, inside a
   subshell. The key is set again even if it is already there: a value
   can't be compared without printing it, and after a rotation the
   environment holds a stale key.
4. **Deliver two files** into `~/.ci-cache/` (`--dir` changes it):
   - `ci-cache-env.sh`, from the engine checkout (`~/dev/ci-cache` or
     `CI_CACHE_REPO`). Keep that checkout on `main`: the header line prints
     the commit it delivers, with `+local changes` when the file is dirty.
   - `install-sccache.sh`, from this skill's
     `templates/sandbox-install-sccache.sh`. It installs sccache 0.19.0 into
     `~/.local/bin` after checking its SHA-256. It does nothing when that
     version is already there. The script refuses to deliver it if its
     version or SHA-256 differ from the setup action's defaults in
     `setup/setup.sh`.
5. **`boat env upgrade`**, so live sandboxes get the new version.

Before every write it prints the target environment and the command, with
variable names only. Sample (klav, 2026-11-09):

```
repo:        OmarAlex24/klav
Boat env:    klav (argument)
key:         CI_CACHE_SANDBOX_KEY from CI_CACHE_SANDBOX_KEY_KLAV in ~/.config/ci-cache/keys.env
files:       ~/dev/ci-cache/scripts/ci-cache-env.sh (7239557) -> /home/user/.ci-cache/ci-cache-env.sh
             ~/.claude/skills/ci-cache/templates/sandbox-install-sccache.sh -> /home/user/.ci-cache/install-sccache.sh

state before:
  version: 8
  variables: CI_CACHE_URL, CI_CACHE_SANDBOX_KEY, RUSTFLAGS, CARGO_TERM_COLOR
  secret files: .ci-cache/ci-cache-env.sh
  live sandboxes: 1
  CI_CACHE_SANDBOX_KEY: set (will be set again)

-> Boat env 'klav': set-var CI_CACHE_SANDBOX_KEY (value from stdin: CI_CACHE_SANDBOX_KEY_KLAV)
{"success":true,"versionNumber":8}
-> Boat env 'klav': set-file .ci-cache/install-sccache.sh (from …/templates/sandbox-install-sccache.sh)
{"success":true,"versionNumber":9}
-> Boat env 'klav': upgrade (push the new version to live sandboxes)
{"success":true,"upgraded":1,"upgradedLive":1,"upgradedStopped":0,"failed":0}
```

Variables that enter cache keys are repo-specific, and the script doesn't
set them. Copy the workflow's values with `set-var` (klav: `RUSTFLAGS=-D
warnings`, `CARGO_TERM_COLOR=always`; see `rust.md`):

```bash
printf '%s' '-D warnings' | boat env set-var <env> RUSTFLAGS --json | jq -c '{success, versionNumber}'
```

| Environment | Repo | Variables | Files |
| --- | --- | --- | --- |
| `klav` | klav (not listed, see below) | `CI_CACHE_URL`, `CI_CACHE_SANDBOX_KEY`, `RUSTFLAGS`, `CARGO_TERM_COLOR` | both |
| `horizon-stack` (created 2026-11-09) | horizon-stack (not listed) | `CI_CACHE_URL`, `CI_CACHE_SANDBOX_KEY` | both |

## Reading Boat environments without printing values

`boat env list` and `boat env info` print variable **values**, and so does
the answer of `boat env new`: it returns every environment in full. A key
leaked twice this way. The only safe read is `--json` piped into a `jq`
filter that emits names, and then the redaction:

```bash
boat env list --json | jq -r '.environments[].name' | sed -E 's/(sk|rk)_[A-Za-z0-9_-]+/\1_***/g'
```

The shape (Boat 1.0.92): `environments[]` with `name`, `isDefault`,
`latestVersionNumber`, and the `pass*` toggles. Three fields hold content:
- `envContents` is the dotenv text, **values included**. Extract names with
  `scan("(?m)^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=")`.
- `secretFiles[]` is `{path, contents}`. Read `.path` only.
- `selectedRepositories[]` lists the repos.

`versions[].sandboxCount` counts live sandboxes. With a new field, list
its paths first (`jq '[paths | map(tostring) | join(".")] | unique'`), never
its values. A write's answer goes through a filter too
(`{success, versionNumber}`), not straight to the terminal.

## Making agents use it: the repo's agent guide

Since nothing runs at startup, the repo's `AGENTS.md`/`CLAUDE.md` tells the
agent what to run. Keep it to a few lines, in the repo's language. Gate it
on the sandbox, so it is a no-op on a laptop:

- Rust repo (klav, `CLAUDE.md`):
  ```
  bash ~/.ci-cache/install-sccache.sh && bash ~/.ci-cache/ci-cache-env.sh
  ```
  then `source ~/.ci-cache.env` in every shell that runs cargo. Agent
  shells don't keep exports between calls.
- Turbo repo (horizon-stack, `AGENTS.md`): `bash ~/.ci-cache/ci-cache-env.sh`,
  then `source ~/.ci-cache.env` before Turbo. Run tests with
  `TURBO_CACHE=local:rw` when CI does: horizon's tests read files Turbo
  doesn't hash, so a remote hit could replay a stale pass.

Both say: only in a Boat sandbox (`BOAT_ID` set and `~/.ci-cache/`
present), refresh after a branch switch and every 6 h, work on the PR's
head branch, and rebase onto `origin/main` before the final build.

## Per session: refresh, branch, rebase

In the sandbox, from the repo directory:

```bash
cd /home/user/<repo>
bash ~/.ci-cache/install-sccache.sh        # Rust repos; a no-op once installed
bash ~/.ci-cache/ci-cache-env.sh && source ~/.ci-cache.env
```

- **Run it again after every `git switch`.** The session is bound to the
  branch it was minted for. After a switch, the old token keeps writing to
  the old branch's prefix.
- **Run it again after 6 h.** The token expires, and every read then fails
  as a miss.
- The script stops the sccache server, so the next build starts one with the
  new token.
- It needs a branch: on a detached HEAD it fails, unless `CI_CACHE_BRANCH`
  is set.
- The sandbox's branch **name must equal the PR's head branch**. A
  `wip/foo` sandbox feeds nothing to a PR from `foo`.

## The sandbox → PR flow

1. Work and build in the sandbox on the PR's branch.
2. **Rebase on `origin/main` right before the final build.** PR CI
   compiles the **merge** with main. If main moved, the crates it changed,
   and the crates that depend on them, miss.
3. Build what CI will build, with the same profile and features (`cargo
   build --locked`, `cargo clippy --all-targets`, `cargo test --no-run`).
   The sandbox writes those objects to the branch tier.
4. Push. PR CI reads the branch tier first, then `main/`.
5. Check the reuse with `scripts/cache-stats.sh <owner/repo> --branch <name>`:
   - `ciHitsOnSandboxObjects / sandboxWrites` is the share of what the
     sandbox compiled that CI reused. klav measured **96 %**.
   - `reuseAlert` flips to `true` only when `sandboxWrites` is at least
     **20** and CI reused none of them. Below that, read the ratio.

The first `main` run after onboarding is cold: until it ends, a sandbox
falls back to an empty `main/`.

## Verifying with one sandbox start

Each sandbox start costs one of the plan's starts. One is enough:

```bash
boat new --environment <env> --ttl 7200 --name ci-cache-smoke --json | jq -r '.id' | sort -u
boat exec <id> --timeout 120 -- bash -lc '…'   # names only: compgen -e, ${VAR:+set}, sed 's/=.*//'
boat usage <id>                                 # seconds and dollars
boat delete <id> --yes
```

- In one `bash -lc` (exports don't survive between `exec` calls):
  1. install sccache;
  2. `cargo new --vcs git` and a branch with a distinctive name;
  3. `ci-cache-env.sh`, then `source`;
  4. build, then `sccache --show-stats`;
  5. `cargo clean` and build again. The second build should hit.
- `boat exec --timeout 0` streams JSON frames and may return before the
  command ends. Read the output with
  `boat history <id> <cmd_…> -f`.
- `/v1/stats/branches` comes from Analytics Engine, a few minutes behind.
  If the branch isn't there yet, read it again later.

The 2026-11-09 run on klav, a `default` machine for 260 s, cost
**$0.0026**:
- the session was `rama` on `ci-cache/smoke-20261109`;
- `~/.ci-cache.env` was mode 600, with `RUSTC_WRAPPER` exported;
- the cold build missed once;
- after `cargo clean`, it got 1/1 Rust hits from the Worker;
- `/v1/stats/branches` showed `sandboxWrites: 1`.

## What only Omar can do

- **Connect repos for sandboxes** in Boat's GitHub settings. Until then,
  `boat env add-repo <env> OmarAlex24/<repo>` fails with "repo not
  connected for sandboxes", and the environment doesn't clone the repo. On
  2026-11-09 neither `klav` nor `horizon-stack` listed its repo.
- **Start agent sandboxes with `--environment <env>`.** `base`, the
  default, carries no key. CI runners start from it, so keep keys out of it.

## Never print secrets

- No `echo $CI_CACHE_SANDBOX_KEY`, no `env | grep CI_CACHE`, no `set -x`
  around a line that expands it. Test it with `${VAR:+set}`. List variable
  names with `compgen -e`.
- Read `~/.ci-cache.env` with `sed 's/=.*//'`, never `cat`: it holds the
  session token.
- The fingerprint script filters `token|key|secret` out of its variable
  list, but **don't paste raw `env` output** anywhere.
- If a key leaks (in a log, a PR, a chat), rotate it (`keys.md`).
