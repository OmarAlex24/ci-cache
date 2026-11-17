# Contributing

Issues and pull requests are welcome. Before you open a PR:

- Read [`AGENTS.md`](AGENTS.md), above all its **Invariants**: the client never picks its
  tier, wire values and env var names are fixed, tokens and keys are never logged.
- Run what your change touches: `pnpm check`, the matching `pnpm e2e:*`, `pnpm lint:sh` for
  shell scripts and `pnpm lint:openapi` when `openapi.yaml` changes
  ([Development](README.md#development)). None of them needs a Cloudflare account.
- Never paste a key, a session token or the Worker's URL into an issue, a PR or a log.
- Changing `scripts/ci-cache-env.sh`, `scripts/cache-fingerprint.sh` or
  `skill/ci-cache/templates/sandbox-install-sccache.sh`? Update their SHA-256 lines in
  `scripts/install-sandbox.sh` (`bash scripts/install-sandbox.sh --check-sums` prints them).
- Commits are `<type>: <description>` (`feat`, `fix`, `docs`, `chore`, …).

New cache protocols follow [Adding support for your stack](README.md#adding-support-for-your-stack).

## A sandbox provider recipe

ci-cache works in any sandbox that can run a bash script, but each provider puts secrets,
boot commands and clones in its own place. A recipe says where, for one provider, so its
users don't have to work it out. Add it as a section under "Recipes" in the README's
[Sandboxes](README.md#sandboxes-scriptsci-cache-envsh), or as a page linked from there, with
this template. Only write what you ran: mark anything you didn't check as "untested".

````markdown
### <Provider> (tested with <provider CLI or image version>, <date>)

**Secrets.** Where `CI_CACHE_URL` and `CI_CACHE_SANDBOX_KEY` go so that every shell the
agent starts sees them, and how to set them without the value showing up on screen or in the
provider's logs:

```sh
<command that stores the key from stdin, never as an argument>
```

Mint the key with its own label: `mint-sandbox-key.sh <owner/repo> <provider>`.

**Boot.** The command that installs the client, and where it runs (image build, startup
hook, the agent's instructions):

```sh
ref=<full commit SHA of OmarAlex24/ci-cache>
curl -fsSL "https://raw.githubusercontent.com/OmarAlex24/ci-cache/$ref/scripts/install-sandbox.sh" |
  bash -s -- --ref "$ref" [--rust]
```

**Clone path.** Where the provider clones the repo (`<path>`), and the matching action input:

```yaml
- uses: OmarAlex24/ci-cache/setup@<sha>
  with:
    url: ${{ secrets.CI_CACHE_URL }}
    workdir-path: <path>        # omit if it is /home/user/<repo>
```

**Each session.** What the agent runs before building (usually
`bash ~/.ci-cache/ci-cache-env.sh && source ~/.ci-cache.env`, then `source ~/.ci-cache.env`
in each new shell), and anything the provider needs on top (a login shell, a working
directory).

**Verify.** What you saw:
- `ci-cache-env.sh` printed `ci-cache: rama session for branch '<branch>' …`;
- a second build hit: after `cargo clean`, in `sccache --show-stats`; with Turbo, `cache
  hit, replaying logs` per task;
- the PR's job summary row "Fingerprint vs sandbox" said it matches (or which lines differed and
  how you aligned them);
- `GET /v1/stats/branches?repo=<repoId>` with an `rk_` key: `ciHitsOnSandboxObjects` close
  to `sandboxWrites`.

**Gotchas.** Toolchain or `RUSTFLAGS` the image sets differently from CI, files written with
a mode the scripts don't expect, no git branch on boot (`CI_CACHE_BRANCH`), …
````
