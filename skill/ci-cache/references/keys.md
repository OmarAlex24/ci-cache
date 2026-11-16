# Keys: minting, storing, uploading, rotating

There are three kinds of credential:
- **Sandbox keys** (`sk_…`): one per repo, used by Boat sandboxes to get a
  `rama` session.
- **Stats keys** (`rk_…`): read-only metrics.
- **Session tokens**: minted by the Worker, 6 h.

The Worker stores only the **sha256** of each key. The plaintext exists in
exactly two places: the engine owner's local key files and the repo's Boat
environment.

## Contents
- Where keys live
- Minting a sandbox key
- Uploading the map (the dangerous step)
- Stats keys
- Rotating a leaked key

## Where keys live

`~/.config/ci-cache/` (directory and files mode 600):

| File | Content |
| --- | --- |
| `keys.env` | `CI_CACHE_SANDBOX_KEY_<REPO>=sk_…` (one per repo, the repo name uppercased with `-` → `_`) and `CI_CACHE_STATS_KEY=rk_…` |
| `sandbox_keys.json` | the **full** `SANDBOX_KEYS` map, `{"<sha256>": {"repoId", "repo", "label"}}`: what gets uploaded |
| `stats_keys.json` | the full `STATS_KEYS` map |
| `session_secret` | the Worker's `SESSION_SECRET` |

Rules:
- **Never `cat`, `grep` without `-q`, or `source` these files in a way that
  prints.**
  - To list what exists, print the names only:
    `sed 's/=.*//' ~/.config/ci-cache/keys.env`.
  - To read one value into a command, use a subshell with `set +x` and pipe
    it, as `sandbox.md` shows.
- Never copy values, hashes or repo ids from these files into a skill, a PR
  or a commit.
- `jq 'map_values(.repo)' sandbox_keys.json` prints hashes. Use
  `jq '[.[] | .repo]'` instead.

## Minting a sandbox key

Use the skill's wrapper. It calls the engine's `scripts/new-key.mjs`,
captures its output without printing it, merges the hash into
`sandbox_keys.json` and appends the plaintext to `keys.env`:

```bash
bash ~/.claude/skills/ci-cache/scripts/mint-sandbox-key.sh <owner>/<repo> [label]
```

- It resolves the numeric repo id with `gh api repos/<repo> --jq .id`.
- It refuses if the repo already has a key. Pass `--rotate` to replace it,
  which also drops the old hash from the map.
- `CI_CACHE_KEYS_DIR` (default `~/.config/ci-cache`) and `CI_CACHE_REPO`
  (the engine checkout; by default the clone the skill lives in, otherwise
  required) set the paths. Test it with a temporary
  `CI_CACHE_KEYS_DIR`.
- It prints the variable name, the number of entries in the map and the two
  next commands. It never prints the key or the hash.

Calling `node scripts/new-key.mjs` directly prints the plaintext key to the
terminal, and the terminal may be a log. Don't.

## Uploading the map (the dangerous step)

`wrangler secret put SANDBOX_KEYS` **replaces the whole secret**. Upload
the merged file with every repo's entry. A lone new entry would lock every
other repo's sandboxes out.

Before uploading, check that the file is complete, and get the engine
owner's OK (it writes to the production Worker):

```bash
cd "$CI_CACHE_REPO"
echo "Target: Worker ci-cache ($(jq -r .name wrangler.jsonc 2>/dev/null || echo ci-cache)), secret SANDBOX_KEYS"
jq -r '[.[] | .repo] | sort | .[]' ~/.config/ci-cache/sandbox_keys.json   # repos only, no hashes
pnpm wrangler secret put SANDBOX_KEYS < ~/.config/ci-cache/sandbox_keys.json
```

`wrangler.jsonc` has comments, so `jq` may fail on it. The fallback name is
fine: the Worker is `ci-cache`.

The new key works as soon as the secret is updated, with no redeploy. Test
it from a sandbox with `ci-cache-env.sh`. A 401 means the hash didn't make
it into the map.

If the local `sandbox_keys.json` might be behind the Worker (someone minted
elsewhere), stop. The Worker's secret can't be read back. Ask the engine
owner which map is current.

## Stats keys

`node scripts/new-key.mjs stats <label> [repoId,…]`. The optional ids limit
which repos the key can read. Same handling: capture the output, merge into
`stats_keys.json`, then `wrangler secret put STATS_KEYS` with the full map.
A stats key with no repo ids (it reads every repo), saved as
`CI_CACHE_STATS_KEY` in `keys.env`, is enough for `cache-stats.sh`. Mint a new one only for a new consumer.

## Rotating a leaked key

1. `mint-sandbox-key.sh <repo> --rotate`: a new key, and the old hash
   removed from the map.
2. Upload the map (above). The old key stops working at that moment.
3. Update the Boat environment with `scripts/connect-sandbox.sh <repo>`.
   It sets the key again and runs `boat env upgrade <env>` (`sandbox.md`).
4. Sessions minted with the old key stay valid until they expire (6 h at
   most). There is no revocation list. If that matters, rotate
   `SESSION_SECRET`, which invalidates **every** session, CI included, for
   everyone.
