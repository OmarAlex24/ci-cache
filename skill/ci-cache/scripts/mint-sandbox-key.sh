#!/usr/bin/env bash
# Mints a ci-cache sandbox key (sk_...) for one repo and stores it WITHOUT printing it:
# the plaintext goes to keys.env, its sha256 entry is merged into sandbox_keys.json
# (the full SANDBOX_KEYS map that gets uploaded to the Worker).
#
#   mint-sandbox-key.sh <owner/repo> [label] [--rotate]
#
# Env:
#   CI_CACHE_KEYS_DIR  key directory (default ~/.config/ci-cache)
#   CI_CACHE_REPO      engine checkout with scripts/new-key.mjs (default ~/dev/ci-cache)
#   CI_CACHE_REPO_ID   numeric GitHub repo id (skips `gh api repos/<repo>`)
#
# Prints only names, counts and the next commands. Uploading the map is a separate,
# manual step (wrangler secret put SANDBOX_KEYS), because it writes to production.
set -euo pipefail
set +x # never trace this script: it handles a plaintext key

usage() {
  echo "usage: mint-sandbox-key.sh <owner/repo> [label] [--rotate]" >&2
  exit 2
}

repo="" label="boat-sandbox" rotate=false
for arg in "$@"; do
  case $arg in
    --rotate) rotate=true ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      if [[ -z $repo ]]; then repo=$arg; else label=$arg; fi
      ;;
  esac
done
[[ $repo == */* ]] || usage

keys_dir=${CI_CACHE_KEYS_DIR:-$HOME/.config/ci-cache}
engine=${CI_CACHE_REPO:-$HOME/dev/ci-cache}
new_key=$engine/scripts/new-key.mjs
[[ -f $new_key ]] || { echo "no $new_key (set CI_CACHE_REPO)" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

repo_id=${CI_CACHE_REPO_ID:-}
if [[ -z $repo_id ]]; then
  repo_id=$(gh api "repos/$repo" --jq .id) || { echo "could not resolve the id of $repo" >&2; exit 1; }
fi
[[ $repo_id =~ ^[1-9][0-9]*$ ]] || { echo "bad repo id: $repo_id" >&2; exit 1; }

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }

# klav -> CI_CACHE_SANDBOX_KEY_KLAV, horizon-stack -> ..._HORIZON_STACK (bash 3.2-safe).
var=CI_CACHE_SANDBOX_KEY_$(printf '%s' "${repo#*/}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')

umask 077
mkdir -p "$keys_dir"
chmod 700 "$keys_dir"
env_file=$keys_dir/keys.env
map_file=$keys_dir/sandbox_keys.json
[[ -f $env_file ]] || : >"$env_file"
[[ -f $map_file ]] || echo '{}' >"$map_file"
chmod 600 "$env_file" "$map_file"
jq -e 'type == "object"' "$map_file" >/dev/null || { echo "$map_file is not a JSON object" >&2; exit 1; }

old_hash=""
if grep -q "^$var=" "$env_file"; then
  if [[ $rotate != true ]]; then
    echo "$var already exists in $env_file; pass --rotate to replace it" >&2
    exit 1
  fi
  old_key=$(sed -n "s/^$var=//p" "$env_file" | head -1)
  old_key=${old_key//\"/}
  old_key=${old_key//\'/}
  old_hash=$(printf '%s' "$old_key" | sha256)
  unset old_key
fi

# new-key.mjs prints: line 1 "...: <key>", line 2 a heading, line 3 the JSON entry.
out=$(node "$new_key" sandbox "$repo_id" "$repo" "$label")
key=$(printf '%s\n' "$out" | sed -n '1s/.*: //p')
entry=$(printf '%s\n' "$out" | sed -n '3p')
unset out
[[ $key == sk_* ]] || { echo "unexpected output from new-key.mjs" >&2; exit 1; }
printf '%s' "$entry" | jq -e 'type == "object" and length == 1' >/dev/null ||
  { echo "unexpected entry from new-key.mjs" >&2; exit 1; }

tmp_map=$(mktemp "$keys_dir/.sandbox_keys.XXXXXX")
tmp_env=$(mktemp "$keys_dir/.keys.env.XXXXXX")
trap 'rm -f "$tmp_map" "$tmp_env"' EXIT
jq --argjson entry "$entry" --arg old "$old_hash" \
  'with_entries(select(.key != $old)) + $entry' "$map_file" >"$tmp_map"
grep -v "^$var=" "$env_file" >"$tmp_env" || true
printf '%s=%s\n' "$var" "$key" >>"$tmp_env"
unset key entry
chmod 600 "$tmp_map" "$tmp_env"
mv "$tmp_map" "$map_file"
mv "$tmp_env" "$env_file"
trap - EXIT

count=$(jq 'length' "$map_file")
echo "ci-cache: sandbox key for $repo (id $repo_id) stored as $var in $env_file"
if [[ -n $old_hash ]]; then echo "ci-cache: the old key's entry was removed from the map"; fi
echo "ci-cache: $map_file now holds $count entries: $(jq -r '[.[] | .repo] | sort | join(", ")' "$map_file")"
cat <<EOF

Next (both write to shared infrastructure: confirm with Omar first):
  1. Upload the FULL map (it replaces the secret):
       cd "$engine" && pnpm wrangler secret put SANDBOX_KEYS < "$map_file"
  2. Put the key in the repo's Boat environment, from stdin, output redacted:
       ( set +x; . "$env_file"; printf '%s' "\${$var}" ) |
         boat env set-var <env> CI_CACHE_SANDBOX_KEY 2>&1 | sed -E 's/sk_[A-Za-z0-9_-]+/sk_***/g'
       boat env upgrade <env>
EOF
