# ci-cache

A [Claude Code](https://claude.com/claude-code) skill that onboards a
repository onto the **ci-cache** engine (`OmarAlex24/ci-cache`: a
Cloudflare Worker on R2). The engine gives GitHub Actions and Boat sandboxes
one shared remote build cache:
- **sccache** over WebDAV for Rust;
- the **Turbo** remote cache API for TS/JS monorepos.

There is one `main/` tier, written only by CI on pushes to main, and one
tier per branch, written by the agent's sandbox and by the PR's CI. An
agent's build warms the PR, and nothing an agent writes ever reaches
`main/`.

It is the complement of the `boated-ci` skill. boated-ci turns many CI jobs
into one job (fewer machine starts). This skill makes that job fast by
caching inside it.

From the first rollout (a Rust workspace + browser extension + Docker
monorepo):
- PR CI reused **96 %** of what the sandbox compiled;
- a warm main ran at **99.84 %** Rust hits;
- the Docker task went from 406–485 s to **23 s** warm;
- the job median went from 12.4 min to ~10 min (n = 53 before, 4–5 after).

## What the skill gives the agent

- **A playbook**: audit, keys, CI wiring per stack (Rust, Turbo, Docker),
  sandbox wiring, verification and measurement, with a checklist, pitfalls
  and rollback.
- **Hard rules** learned the hard way:
  - never print a key (`boat env info` leaked one twice);
  - a cache never turns a job red;
  - writes to shared infrastructure need the owner's OK;
  - every push costs a Boat start.
- **Scripts** (bash + jq + gh, shellcheck-clean, nothing to install):
  - `audit-cache.sh`: stacks, cache steps and their order, parity risks,
    and Actions cache usage by prefix and ref against the 10 GB limit.
  - `mint-sandbox-key.sh`: mints an `sk_` key with the engine's
    `new-key.mjs` and merges it into the local key files, without printing
    it.
  - `connect-sandbox.sh`: wires a repo's Boat environment (both
    variables from stdin, the session script and an sccache installer as
    secret files, `boat env upgrade`), printing names only.
  - `fingerprint-diff.sh`: diffs a sandbox fingerprint against a CI run's
    log and marks every difference that breaks cache keys.
  - `cache-stats.sh`: `/v1/stats` and `/v1/stats/branches`, with the
    sandbox→CI reuse ratio per branch.
  - `job-durations.sh`: first-attempt job durations and the median.
  - `machine-class.sh`: iowait and steal per run from boated-ci's machine
    samples (fast vs slow-io machines).
- **Templates**: `templates/cached-job.yml`, one actionlint-clean job wired
  for all three stacks, and `templates/sandbox-install-sccache.sh`, the
  pinned sccache installer delivered into sandboxes.
- **References**:
  - `engine.md`: endpoints, tiers, action inputs and outputs, exported
    variables;
  - one page per stack: `rust.md`, `turbo.md`, `docker.md`;
  - `sandbox.md` and `keys.md`;
  - `measurement.md` and `case-study.md` (the first rollout);
  - `roadmap.md`: test-result replay, Go and the other v2 items.

## Versioning

The source of truth is `skill/ci-cache/` in the engine repo
(`OmarAlex24/ci-cache`), next to the code it describes. The installed copy
lives at `~/.claude/skills/ci-cache/`. When the engine changes (new action
inputs, endpoints, variables), update both in the same PR.
