# Measuring a cache change

A cache PR is a hypothesis: "this makes the job faster". Boat machines are
noisy enough that one run proves nothing. This page is the protocol klav
used, and the traps it found.

## Contents
- What to measure
- Machine classes
- How many runs, and which
- Timing inside a task
- Reading the cache's own numbers
- Spending starts on measurement
- Speed-ups that are not the cache

## What to measure

- **Job duration from the jobs API**: `completed_at − started_at` of the
  job, **first attempt only** (`/actions/runs/<id>/attempts/1/jobs`). A rerun
  skips tasks that already passed (boated-ci) and lands on a warm machine,
  so it isn't comparable. `scripts/job-durations.sh` does this and prints
  the median:

  ```bash
  bash scripts/job-durations.sh O/R --job ci --event pull_request --limit 20
  ```

  The run's wall-clock time (`gh run list`) includes queueing. Don't use it.
- **Per task**: boated-ci's `task-metrics.ts` table gives the seconds per
  task and the machine's CPU and steal in each task's window. Use it to find
  which task is the critical path. A cache that speeds up a task off the
  critical path doesn't move the job.
- **The cache**: `sccache --show-stats` in the job summary, and
  `scripts/cache-stats.sh` for the Worker's view.

## Machine classes

Boat machines come in two classes that dominate the variance:

| Class | iowait over the job | Effect seen in klav |
| --- | --- | --- |
| fast | ~2 % | job ~333–434 s |
| slow-io | 15–23 % | the same work at 536–702 s; clippy 306 s instead of ~190 s; `docker run` checks at 10–60 s each |

Steal stayed below 1 % in klav's runs, but check it anyway. Over ~8 %, the
run is noise.

Classify **every** run before comparing:

```bash
gh run download <run-id> -R O/R -n machine-samples-1 -D /tmp/s
bash scripts/machine-class.sh /tmp/s/machine-samples.txt
```

That needs boated-ci's `machine-sampler.sh` early in the job and the
samples uploaded as the `machine-samples-<attempt>` artifact. Compare
medians **within** a class. Report the class with each number.

## How many runs, and which

- **5 or more first attempts per variant** before a verdict.
  `job-durations.sh` flags anything under 5. Use the PRs that land anyway,
  rather than paying for extra runs (see "Spending starts" below).
- **Separate cold from warm.** These are cold:
  - the first `main` run after onboarding, which fills `main/`;
  - the first run after a `prefix-key` bump;
  - the first write to a BuildKit scope;
  - a PR that changes `Cargo.lock` or a core crate.
- **Separate PRs that touch the cached code** (a Rust change misses its own
  crates and the crates that depend on them) from PRs that don't (docs, CI,
  the extension).
- **Run variants one after another, not in parallel.** Parallel runs share
  hosts and inherit correlated noise.

## Timing inside a task

Put elapsed seconds on every command of a long script:

```bash
PS4='+ [${SECONDS}s] '
set -x
```

**Never let a trace show a secret.** `set -x` prints each expanded command.
Test presence with `${VAR:+set}`, never with the value:

```bash
if [ -n "${ACTIONS_RUNTIME_TOKEN:+set}" ]; then …   # the trace shows "set"
```

Masking (`::add-mask::`, `core.setSecret`) protects the runner's log, but
not files that a background task writes. Those need boated-ci's
`ci-task.ts mask` or equivalent.

To see where the time goes:
- grep cargo logs for `Blocking waiting for file lock on build directory`
  (serialized tasks, see `rust.md`);
- find a large restore before the first task (rust-cache's
  `Cache restored` line, and its size);
- check BuildKit's `exporting cache` time.

## Reading the cache's own numbers

- `sccache --show-stats`:
  - a hit rate above ~95 % on a warm PR;
  - misses at about the number of crates the PR changed;
  - 0 timeouts and 0 write errors.
- `cache-stats.sh O/R --range 24h`:
  - `hit-main` share (`from-main`): how much branches lean on main;
  - per branch, `reuse` = `ciHitsOnSandboxObjects / sandboxWrites`.
    klav: **96 %** of what the sandbox compiled on `ci/cache-r2` was reused
    by its PR's CI.
  - `reuseAlert` is true at ≥ 20 sandbox writes with 0 reused. It is also
    true on a branch CI never read (a benchmark branch, a sandbox-only
    experiment), which the script shows as `no-ci`. Not an error there.
- `byKind.sandbox` hit rate tells you whether sandboxes are reading `main/`
  well. A low rate usually means the sandbox's environment differs from
  CI's (`fingerprint-diff.sh`).

## Spending starts on measurement

Every push costs a Boat start (boated-ci). Measuring must not blow the
budget:
- **Push only the top branch of a stack.** In a stack of N PRs, a push to
  the base re-runs all N.
- **Measure on the PRs that are landing anyway** when you can.
- **Temporary instrumentation** (an extra `set -x`, a forced cold run, a
  variant toggle) goes in its own commit, and a later commit reverts it.
  Force-push may be blocked by repo rules, and the history shows exactly
  what was measured.
- Prefer a repository variable as the knob (`gh variable set …`) over a
  code change, so variants need no push.

## Speed-ups that are not the cache

Look for these while measuring. Each one is cheap:
- **Overlap I/O with CPU inside a task.** Start downloads and installs
  (`apt`, a browser, a toolchain) in the background at the top of the task,
  and wait for them right before they are needed. klav's `extension` task
  went from ~636 s to 287 s at best.
- **`dpkg force-unsafe-io` on ephemeral runners.** dpkg fsyncs every file,
  and with other tasks' builds on the same disk, `install-deps` took
  53–232 s. With it, 18 s:

  ```bash
  echo force-unsafe-io | sudo tee /etc/dpkg/dpkg.cfg.d/ci-unsafe-io >/dev/null
  ```
- **cargo-nextest** for test binaries that run one after another (`rust.md`).
- **Don't restore what a remote cache already serves**: klav's `target/`
  restore cost ~60 s in the foreground.
