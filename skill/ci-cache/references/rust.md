# Rust: sccache through ci-cache

A sandbox and CI share compiled crates only when sccache computes the **same
hash** for the same compilation on both sides. This page covers what enters
that hash, how to line up the two sides, and how rust-cache fits in without
breaking it.

## Contents
- What enters an sccache key
- The path: bind mount and CI_WORKDIR
- The environment: make the sandbox match CI
- The toolchain
- Reuse the image's toolchain under the pinned name
- rust-cache: order, prefix-key, ~/.cargo only
- The job snippet
- Shared target/ and the build-directory lock
- Reading sccache --show-stats
- Latency notes

## What enters an sccache key

For each `rustc` call, sccache hashes:
- the full argument list, which includes the source path, `--out-dir`,
  `-C` flags and every flag that `RUSTFLAGS` adds;
- the **cwd**, which `cargo` sets to the workspace root;
- the **content of every `--extern` rlib**;
- every `CARGO_*` variable cargo passes to rustc (`CARGO_PKG_*`,
  `CARGO_MANIFEST_DIR`, and also anything like `CARGO_TERM_COLOR`);
- the compiler binary and its sysroot.

Consequences:
- **The path must match.** The Boat CI checkout is
  `$HOME/actions-runner/_work/<repo>/<repo>`; Boat sandboxes clone to
  `/home/user/<repo>` as user `user`. Different cwd means different keys.
- **A `target/` that comes from somewhere else poisons the keys.** If a
  restored `target/` holds rlibs built at another path, or without sccache,
  then every crate that depends on them hashes differently. They compile
  locally, sccache uploads the results under keys nobody will look up, and
  the hit rate collapses. One test in the first rollout got 0 hits out of 36.
- **The env must match**, down to `CARGO_TERM_COLOR`.
- `CARGO_INCREMENTAL=0`: sccache does not cache incremental compilations.
  The action and `ci-cache-env.sh` both set it.
- **Linking crates** (`bin`, `dylib`, `cdylib`, `proc-macro`) are never
  cached. They show under "Non-cacheable reasons" (`crate-type`). The hit
  rate in `--show-stats` counts only cacheable calls. Their dependencies are
  still cached.

## The path: bind mount and CI_WORKDIR

The setup action's `mount-workdir` (default `auto`) bind-mounts the checkout
at `/home/user/<repo>` when the repo has a `Cargo.toml` and the runner is
Linux with passwordless sudo. Otherwise, or if the target is not empty or the
mount fails, it logs why and builds in `$GITHUB_WORKSPACE` (exit 0).
`"true"` forces the mount and fails if it can't; `"false"` never mounts. Two
more pieces are needed:

```yaml
      - name: "rust: build directory for the tasks"
        if: steps.cache.outputs.workdir != ''
        env:
          WORKDIR: ${{ steps.cache.outputs.workdir }}
        run: echo "CI_WORKDIR=$WORKDIR" >>"$GITHUB_ENV"
```

Every step or background task that runs cargo starts with:

```bash
cd "${CI_WORKDIR:-$GITHUB_WORKSPACE}"
```

The fallback matters. If the action failed (`continue-on-error`), there is
no mount, and the task builds in the workspace.

`working-directory:` on a step works too, but background tasks (boated-ci
`ci-task.ts start`) need the `cd`.

**Verify the mount.** The bind mount is the same directory, so both paths
must show the same device and inode. At the end of the job:

```bash
saved=$(stat -c '%d:%i' "$GITHUB_WORKSPACE/target")
built=$(stat -c '%d:%i' "$CI_WORKDIR/target")
[ "$saved" = "$built" ] || echo "::warning::target/ under the workspace is not the one the tasks built"
```

The fingerprint printed by the action shows `checkout: /home/user/<repo>`
when the mount worked.

## The environment: make the sandbox match CI

1. List what the workflow sets at the workflow, job and step level that
   enters keys: `RUSTFLAGS`, `RUSTDOCFLAGS`, `CARGO_*` (`CARGO_TERM_COLOR`,
   `CARGO_PROFILE_*`, `CARGO_BUILD_*`), `CC`, `CXX`, `CFLAGS`, `LDFLAGS`.
2. Set the **same values** in the repo's Boat environment
   (`sandbox.md`). In the first rollout, that was `RUSTFLAGS=-D warnings` and
   `CARGO_TERM_COLOR=always`.
3. Prefer **few** such variables. A flag that lives in
   `.cargo/config.toml` (`[build] rustflags`, `[term] color`) is read by
   both sides from the repo, with nothing to keep in sync.
   - Caveat: `RUSTFLAGS` in the environment **overrides**
     `build.rustflags` in config; the two don't add up.
4. Variables that don't reach rustc don't matter: `SCCACHE_*`, `TURBO_*`,
   `CI_WORKDIR`, `GITHUB_*`.
5. Check with the fingerprints (below).

Step-level `env:` that sets `RUSTFLAGS` differently for one task, for
example `-C instrument-coverage` for coverage, gives that task its own key
space. That's fine, but a sandbox build won't feed it.

## The toolchain

- Pin it in `rust-toolchain.toml` with an exact version
  (`channel = "1.97.1"`). With `channel = "stable"`, both sides resolve
  stable on their own. On a Rust release day the sandbox and CI can run
  different compilers, and every key differs.
  - The first rollout pinned 1.97.1. That was the release Boat's image
    shipped as `stable`, while upstream stable was 1.99.1.
- **Pin the release the runner image ships.** CI downloads any other one on
  every run, until the image catches up. Read it from the `rustc` line of
  the toolchain step in a CI log.
- **A bump is a PR of its own**, and the next builds are cold once: every
  crate misses on the first runs on main, on each branch and in every
  sandbox.
- **Rename the image's `stable` before any rustup call** (next section).
  Pinning the image's own release still downloads it otherwise.
- Use the image's rustup. Don't `rustup self update` in CI.
- Same target triple. Extra targets (`wasm32-unknown-unknown`) are fine:
  each target has its own keys.
- The same sccache version on both sides (0.19.0). The action installs
  0.19.0; in the sandbox, install that version.
- **A re-downloaded or renamed toolchain doesn't make the cache cold.**
  sccache 0.19's keys don't include the toolchain's path. In the first
  rollout, the same release downloaded again, then renamed, got 100 % Rust hits
  (about 2,250 requests per run, 0 misses).

## Reuse the image's toolchain under the pinned name

rustup knows toolchains only by their directory name. Boat's image ships
its release as `stable-x86_64-unknown-linux-gnu`. A pin of that same
release looks for `1.97.1-x86_64-unknown-linux-gnu`, doesn't find it, and
downloads it again. In the first rollout that took 150 s and 5.6 s (n=2, two Boat runs
twelve minutes apart), against 2–3 s for the step before the pin.

The fix: when the image's `rustc -V` reports exactly the pin, rename its
toolchain to the pinned name and leave `stable` as a symlink to it.
- **Run it before any rustup command.** In a directory with
  `rust-toolchain.toml`, any command that resolves the active toolchain
  installs the pin when it's missing: `rustup --version` does, and so do
  the `rustc` and `cargo` proxies. In one of the first rollout's runs the
  rename came after `rustup --version` and found the pin already downloaded.
- **Don't ask rustup where its home is.** `rustup show home` doesn't
  install anything, but reading `RUSTUP_HOME` avoids calling rustup at all.
- **Touch nothing in any other case.** If the image ships another release,
  rustup downloads the pin as before, and the step warns so that someone
  re-pins.

For any Rust repo on Boat, at the top of the toolchain step (from the first
rollout's `ci.yml`):

```bash
pin=$(sed -nE 's/^channel *= *"([0-9]+\.[0-9]+\.[0-9]+)"$/\1/p' rust-toolchain.toml)
toolchains="${RUSTUP_HOME:-$HOME/.rustup}/toolchains"
for stable in "$toolchains"/stable-*; do
  [ -n "$pin" ] && [ -d "$stable" ] && [ ! -L "$stable" ] || continue
  pinned="$toolchains/$pin-${stable##*/stable-}"
  image=$("$stable/bin/rustc" -V 2>/dev/null || true)
  if [ -e "$pinned" ]; then
    echo "${pinned##*/} is already installed"
  elif [[ $image == "rustc $pin "* ]]; then
    mv "$stable" "$pinned" && ln -s "${pinned##*/}" "$stable" &&
      echo "The image's stable is rustc $pin: reused as ${pinned##*/}"
  else
    echo "::warning::The image's stable is '${image:-unknown}', not the pinned $pin: every run downloads $pin"
  fi
done
rustup toolchain install   # from rust-toolchain.toml: nothing to download after the rename
```

- **Check it in the log**: `reused as 1.97.1-x86_64-unknown-linux-gnu`,
  then rustup's `info: using existing install`. In the first rollout the
  step went back to 2–3 s (n=2), with 100 % Rust hits.
- **Sandboxes don't run this step.** Each sandbox downloads the pin once,
  the first time `cargo` runs in the repo (`sandbox.md`, `roadmap.md`).
- **Rejected: `~/.rustup` in the Actions cache.** It's about 600 MB, and
  the Actions cache delivered 0.7–15 MB/s to Boat when it was measured.

## rust-cache: order, prefix-key, ~/.cargo only

`Swatinem/rust-cache` still earns its place for `~/.cargo`: the registry
index, the crate sources and the git checkouts. Compiled code should come
from sccache.

- **Put it after the ci-cache action.** rust-cache hashes every `CARGO*`
  and `RUST*` variable into its key ("Environment considered" in its log),
  so `RUSTC_WRAPPER=sccache` and `CARGO_INCREMENTAL=0` end up in it.
  - Here is what goes wrong in the other order. A main run where ci-cache
    failed compiles without sccache and saves a `target/` under the same
    key every PR restores. That `target/` poisons sccache for every PR.
- **`cache-targets: false`.** Restoring a ~890 MB `target/` took ~60 s in
  the foreground, before any task could start, and the job got slower:
  14.7 min against ~8 min with sccache alone. sccache serves the same
  dependencies to the parallel tasks faster than the restore.
- **Bump `prefix-key` whenever the path, the wrapper or what is cached
  changes** (`v1-rust` → `v2-rust`). Old entries keep matching the restore
  key otherwise, and you restore exactly the `target/` you meant to drop.
  Then propose deleting the old prefix's entries (that needs the repo owner's OK).
  `gh cache delete` takes one id or one exact key, so list them first:

  ```bash
  gh cache list -R O/R --key v1-rust --limit 100 --json id,key,sizeInBytes
  gh cache list -R O/R --key v1-rust --limit 100 --json id --jq '.[].id' |
    xargs -n1 gh cache delete -R O/R
  ```
- `save-if: ${{ github.ref == 'refs/heads/main' }}`: PRs restore main's
  entry and never save their own. This also keeps the 10 GB budget.
- `cache-on-failure: true`: a red task on main still saves `~/.cargo`.

## The job snippet

```yaml
env:
  CARGO_TERM_COLOR: always
  RUSTFLAGS: -D warnings      # the Boat env must hold the same values

jobs:
  ci:
    permissions:
      contents: read
      id-token: write          # OIDC for the ci-cache session
    env:
      SCCACHE_IDLE_TIMEOUT: "0"   # keep the server (and its stats) until the end
    steps:
      - uses: actions/checkout@<sha>
      - name: "rust: toolchain"
        run: |
          # first, the rename from "Reuse the image's toolchain under the pinned name"
          rustup toolchain install   # from rust-toolchain.toml
      - name: "rust: ci-cache"
        id: cache
        continue-on-error: true
        uses: OmarAlex24/ci-cache/setup@<sha>   # pin a full commit SHA
        with:
          url: ${{ secrets.CI_CACHE_URL }}      # a secret, not a variable: GitHub masks it in logs
          # mount-workdir: auto (the default) mounts /home/user/<repo> for Rust
      - name: "rust: build directory"
        if: steps.cache.outputs.workdir != ''
        env:
          WORKDIR: ${{ steps.cache.outputs.workdir }}
        run: echo "CI_WORKDIR=$WORKDIR" >>"$GITHUB_ENV"
      - name: "rust: cache ~/.cargo"
        continue-on-error: true
        uses: Swatinem/rust-cache@<sha> # v2.9.3 or later
        with:
          prefix-key: v2-rust           # bump on path/wrapper/content changes
          cache-targets: false
          cache-on-failure: true
          save-if: ${{ github.ref == 'refs/heads/main' }}
      - name: clippy
        run: |
          cd "${CI_WORKDIR:-$GITHUB_WORKSPACE}"
          cargo clippy --workspace --all-targets --locked
      - name: sccache stats
        if: ${{ !cancelled() }}
        continue-on-error: true
        run: |
          command -v sccache >/dev/null || { echo "no sccache on PATH"; exit 0; }
          sccache --show-stats | tee -a "$GITHUB_STEP_SUMMARY"
```

`templates/cached-job.yml` has the full version, with the inode check.

## Shared target/ and the build-directory lock

Background cargo tasks that share one `target/` (clippy, test, a debug
build for e2e) **serialize** on cargo's build-directory lock. Find the wait
in the logs:

```bash
grep -n 'Blocking waiting for file lock on build directory' task-*.log
```

What to do about it:
- **Order tasks** so the one on the critical path takes the lock first.
- **Merge commands into one invocation** where you can, for example clippy
  `--all-targets` and then the tests.
- **Remove duplicate work.** The first rollout ran `cargo test -p app-server --doc`
  twice, and the second run waited ~2 min on the lock for nothing.
- **Use a separate `CARGO_TARGET_DIR`** only for a task with a different
  profile or flags. It costs disk, but sccache fills it quickly.
- **cargo-nextest** runs test binaries in parallel. The first rollout's `test` task went
  from a 574 s to a 366 s median on busy machines, with a `cargo test`
  fallback when nextest is missing.

## Reading sccache --show-stats

- **Cache hits rate (Rust)** above ~95 % on a warm PR is normal. The first
  rollout got 99.84 % on a warm main, and 98 % on a PR with a warm cache.
- **Cache misses** should be roughly the crates the PR touched, plus the
  crates that depend on them.
- **Cache timeouts and write errors** should be 0.
  - Timeouts come from sccache's fixed 60 s read timeout on its single h2
    connection.
  - A burst of timeouts means the cold cache is saturating that connection
    (many tasks compiling at once), or the bucket is far away.
- **Average cache read hit**: ~0.067 s from Boat to weur.
- **Non-cacheable**: `crate-type` (linking crates) and `-` (rustc probes)
  are expected.

A high miss count with an unchanged `Cargo.lock` almost always means a
parity problem. Diff the fingerprints.

## Fingerprint parity

**Automatic.** `ci-cache-env.sh` uploads the sandbox's fingerprint after
each session (it needs `cache-fingerprint.sh` next to it:
`connect-sandbox.sh` delivers both). On the branch tier, the setup action
downloads it after the mount and compares it with CI's own. Each differing
line that enters the keys becomes, once per item,

```
::warning title=ci-cache cache key mismatch::RUSTFLAGS: sandbox=-D warnings ci=(missing)
```

and a row in the job summary (unset and empty count as equal). If the job
has no `RUSTC_WRAPPER` (sccache off), those lines only go to the summary's
collapsed block, without warnings. The action output `fingerprint-compare` is
`match`, `mismatch`, `none` (no sandbox fingerprint for the branch),
`skipped` or `error`. It never fails the job. The comparison sees the job's
`env:`, not a later step's: keep key variables at job level.

**By hand** (an old action pin, or to compare two arbitrary runs). The
action prints the fingerprint in its step, after the line `== machine`.
In the sandbox, run:

```bash
boat exec <sandbox> 'cd /home/user/<repo> && bash ~/ci-cache/scripts/cache-fingerprint.sh' > sandbox.txt
```

Then save the CI run's log and diff the two:

```bash
gh run view <run-id> -R O/R --log > ci.log
bash scripts/fingerprint-diff.sh sandbox.txt ci.log
```

`fingerprint-diff.sh` accepts a raw fingerprint or a whole `gh run view
--log` file (it extracts the block), and it hides any line that looks like
a secret. It marks each difference:
- `KEY`: breaks sccache keys (path, rustc, toolchain, `RUSTFLAGS`,
  `CARGO_*`, sccache version);
- `info`: harmless (vCPU, RAM, kernel, CI-only variables such as
  `SCCACHE_IDLE_TIMEOUT`).

## Latency notes

- **The bucket region matters.** Two numbers measure different things:
  - per R2 operation, inside the Worker: ~180 ms with a WNAM bucket, and
    50–120 ms with weur;
  - per sccache read, from the client: a mean of ~0.87 s from Boat with
    WNAM, and ~0.067 s (67–170 ms) with weur.
- **Don't move the Worker to the bucket** with `placement`: a 512 KB read
  went up to ~0.9 s.
- **`SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true`** makes each write a single
  `PUT`. Without it, every `PUT` is preceded by a `PROPFIND`. Both the
  action and `ci-cache-env.sh` set it.
- **A cold cache with many parallel cargo tasks** pushes everything through
  one h2 connection. Expect some timeouts on the first main run. They count
  as misses, never as errors.
