# Not built yet (v2) and future work

None of this exists in the engine today. Don't wire a repo as if it did.
Propose it to the engine owner as engine work when a repo needs it.

## Result replay

**Turbo already does it.** On a hit, Turbo restores a task's outputs and
replays its logs, test tasks included, through the same tiers. A `test`
task whose inputs, dependencies and env hash the same is skipped. Make sure
`turbo.json` declares test tasks with the right `inputs` and `outputs`, so
they are cacheable at all.

**Rust test results (designed, not implemented).** Skip running a test
binary when the same binary has already passed. The design:
- The key hashes:
  - the test binary;
  - its sibling binaries (anything it may spawn, such as the server or CLI
    under test);
  - the crate directory's git tree hash (fixtures, test data);
  - the arguments;
  - an **allowlist** of env variables;
  - the tool versions (rustc, nextest).
- The value: the pass result, with its output.
- **`main` always runs everything.** Replay applies only to PRs and
  sandboxes, so a flaky or environment-dependent test can't hide on main.
- It would plug in through the same tiers: a PR reads its branch, then
  `main/`.

## Smaller items

- **A fingerprint diff on the server**: explain *why* the cache missed
  (which input differed) in `/v1/stats/branches`, next to `reuseAlert`.
  Today the setup action does it per run (`/v1/fingerprint` plus
  `setup/fingerprint-compare.sh`), and `scripts/fingerprint-diff.sh` by hand.
- **Go through `GOCACHEPROG`**: a Go cache program speaking to the Worker,
  so `go build` and `go test` share the tiers. Until then, use `setup-go`'s
  Actions cache.
- **Temporary Docker credentials**: short-lived credentials so BuildKit
  could read and write the R2 tiers (a registry or S3-style cache) instead
  of the Actions cache, with the same tier rules.
- **The toolchain rename in `ci-cache-env.sh`**: CI renames the image's
  `stable` to the pinned name when they are the same release (`rust.md`).
  Sandboxes don't run that step, so each one downloads the pin once, the
  first time `cargo` runs in the repo. `ci-cache-env.sh` calls neither
  rustc nor cargo, so it could do the same rename before the agent's first
  build. Not tried yet: check that the sandbox user can write the image's
  toolchains directory.
