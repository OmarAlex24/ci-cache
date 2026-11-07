# Boat sandboxes: wiring the agent's side

The payoff of ci-cache is that the agent's own build in its Boat sandbox
warms the cache for its PR. This page is about that side.

## Contents
- Paths and user
- The Boat environment
- Getting ci-cache-env.sh into the sandbox
- Per session: refresh, branch, rebase
- The sandbox → PR flow
- Never print secrets

## Paths and user

Boat sandboxes clone each repo to **`/home/user/<repo>`** and run as user
**`user`**. Boat CI checks out to
`$HOME/actions-runner/_work/<repo>/<repo>`, which is why CI bind-mounts to
the sandbox path (`rust.md`). If a sandbox clones elsewhere, the paths no
longer match. Fix the sandbox, not CI.

## The Boat environment

Each repo has a named Boat environment (klav's is `klav`). Set these
variables in it:

| Variable | Value |
| --- | --- |
| `CI_CACHE_URL` | `https://ci-cache.omarespinosafernandez.workers.dev` |
| `CI_CACHE_SANDBOX_KEY` | the repo's `sk_…` key, **from stdin** |
| `RUSTFLAGS`, `CARGO_TERM_COLOR`, … | the **same values** as the workflow's `env:` (see `rust.md`) |

`set-var` reads the value from stdin when given `KEY` alone (or `KEY=-`).
The key comes from the local key file, and only the variable name ever
appears on the command line:

```bash
# Prints the target environment first: confirm it is the right one.
env_name=<repo-env>; var=CI_CACHE_SANDBOX_KEY_<REPO>
echo "Boat env: $env_name, variable CI_CACHE_SANDBOX_KEY from $var"
( set +x; . ~/.config/ci-cache/keys.env; printf '%s' "${!var}" ) |
  boat env set-var "$env_name" CI_CACHE_SANDBOX_KEY 2>&1 |
  sed -E 's/sk_[A-Za-z0-9_-]+/sk_***/g'
printf '%s' 'https://ci-cache.omarespinosafernandez.workers.dev' |
  boat env set-var "$env_name" CI_CACHE_URL
printf '%s' '-D warnings' | boat env set-var "$env_name" RUSTFLAGS
printf '%s' 'always'      | boat env set-var "$env_name" CARGO_TERM_COLOR
boat env upgrade "$env_name"   # running sandboxes don't get the new version until this
```

- `sed` redacts any key in the output. Nobody has checked whether `set-var`
  echoes values, so assume it might.
- Each `set-var` mints a new environment version. Running sandboxes stay on
  the old version until `boat env upgrade <env>`. Stopped sandboxes pick it
  up at resume.
- **Never run `boat env info` or `boat env list`.** They print variable
  values. A key leaked twice this way and had to be rotated. To check that a
  variable exists, ask inside a sandbox: `[ -n "${CI_CACHE_SANDBOX_KEY:+set}" ]`.

## Getting ci-cache-env.sh into the sandbox

The script lives in the engine repo (`scripts/ci-cache-env.sh`). Nothing
standard ships it to sandboxes yet. Options:
1. **Add `OmarAlex24/ci-cache` to the Boat environment** (`boat env
   add-repo`). The sandbox then has `/home/user/ci-cache/scripts/`. This is
   the simplest way to keep it current.
2. **`boat env set-file <env> <path> --from ~/dev/ci-cache/scripts/ci-cache-env.sh`**.
   The path is relative to the sandbox workspace. Nobody has verified yet
   where it lands, so check with `ls` in a sandbox before relying on it.
3. **Vendor a copy** in the target repo, for example `scripts/ci-cache-env.sh`.
   It works offline, but it drifts from the engine.

sccache must be on the sandbox's `PATH` at the **same version** as CI
(0.19.0) for `RUSTC_WRAPPER` to be exported. Install the pinned musl build,
the way `setup/setup.sh` does, from its SHA-256.

## Per session: refresh, branch, rebase

In the sandbox, from the repo directory:

```bash
cd /home/user/<repo>
bash /home/user/ci-cache/scripts/ci-cache-env.sh   # or wherever it lives
source ~/.ci-cache.env
```

- **Run it again after every `git switch`.** The session is bound to the
  branch it was minted for. After a switch, the old token keeps writing to
  the old branch's prefix.
- **Run it again after 6 h.** The token expires and every read then fails as
  a miss.
- The script stops the sccache server, so the next build starts one with the
  new token.
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

## Never print secrets

- No `echo $CI_CACHE_SANDBOX_KEY`, no `env | grep CI_CACHE`, no `set -x`
  around a line that expands it. Test it with `${VAR:+set}`.
- The fingerprint script filters `token|key|secret` out of its variable
  list, but **don't paste raw `env` output** anywhere.
- If a key leaks (in a log, a PR, a chat), rotate it (`keys.md`).
