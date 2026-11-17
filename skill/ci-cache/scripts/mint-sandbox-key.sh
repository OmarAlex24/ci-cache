#!/usr/bin/env bash
# Mints a ci-cache sandbox key (sk_...) for one repo and stores it WITHOUT printing it:
# the plaintext goes to keys.env, its sha256 entry is merged into sandbox_keys.json
# (the full SANDBOX_KEYS map that gets uploaded to the Worker).
#
#   mint-sandbox-key.sh <owner/repo> [label] [--rotate]
#
# One key per repo and label, so each sandbox provider (or machine pool) gets its own key
# and rotates on its own. Without a label (or with the default one, "sandbox") the key is
# stored as CI_CACHE_SANDBOX_KEY_<REPO>, the name connect-sandbox.sh reads; with another
# label, as CI_CACHE_SANDBOX_KEY_<REPO>__<LABEL>. A second key for the same repo and label
# is refused; --rotate replaces it and drops the old one's hash from the map (also a key
# minted before labels had their own variable, found by its label in the map).
#
# Env:
#   CI_CACHE_KEYS_DIR  key directory (default ~/.config/ci-cache)
#   CI_CACHE_REPO      engine checkout with scripts/new-key.mjs (default: the clone this
#                      skill lives in, when run from skill/ci-cache/ in that clone)
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

DEFAULT_LABEL=sandbox
repo="" label=$DEFAULT_LABEL rotate=false
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
[[ $label =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "label: 1-40 letters, digits, '.', '_' or '-'" >&2; exit 2; }

keys_dir=${CI_CACHE_KEYS_DIR:-$HOME/.config/ci-cache}
skill_root=$(cd "$(dirname "$0")/.." && pwd)
# The engine checkout: CI_CACHE_REPO, or the clone this skill lives in (skill/ci-cache/).
engine=${CI_CACHE_REPO:-}
if [[ -z $engine && -f $skill_root/../../scripts/ci-cache-env.sh ]]; then engine=$(cd "$skill_root/../.." && pwd); fi
[[ -n $engine ]] || { echo "set CI_CACHE_REPO to your ci-cache checkout (it holds scripts/new-key.mjs)" >&2; exit 1; }
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

# my-repo -> CI_CACHE_SANDBOX_KEY_MY_REPO, app.web -> ..._APP_WEB (bash 3.2-safe);
# label my-provider -> CI_CACHE_SANDBOX_KEY_MY_REPO__MY_PROVIDER.
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_'; }
var=CI_CACHE_SANDBOX_KEY_$(upper "${repo#*/}")
if [[ $label != "$DEFAULT_LABEL" ]]; then var=${var}__$(upper "$label"); fi

umask 077
mkdir -p "$keys_dir"
chmod 700 "$keys_dir"
env_file=$keys_dir/keys.env
map_file=$keys_dir/sandbox_keys.json
[[ -f $env_file ]] || : >"$env_file"
[[ -f $map_file ]] || echo '{}' >"$map_file"
chmod 600 "$env_file" "$map_file"
jq -e 'type == "object"' "$map_file" >/dev/null || { echo "$map_file is not a JSON object" >&2; exit 1; }

# The key this replaces: the variable's, and any entry in the map for this repo and label
# (a key minted before labels had their own variable lives under the label-less name).
old_hashes=$(jq -r --argjson id "$repo_id" --arg label "$label" \
  'to_entries[] | select(.value.repoId == $id and .value.label == $label) | .key' "$map_file")
if grep -q "^$var=" "$env_file"; then
  old_key=$(sed -n "s/^$var=//p" "$env_file" | head -1)
  old_key=${old_key//\"/}
  old_key=${old_key//\'/}
  old_hashes+=$'\n'$(printf '%s' "$old_key" | sha256)
  unset old_key
fi
old_hashes=$(printf '%s\n' "$old_hashes" | sed '/^$/d' | sort -u)
if [[ -n $old_hashes && $rotate != true ]]; then
  echo "$repo already has a sandbox key labeled '$label' ($var); pass --rotate to replace it, or mint another label" >&2
  exit 1
fi
# Variables in keys.env that hold one of the replaced keys (by hash: no value is printed).
stale_vars=()
while IFS= read -r line; do
  name=${line%%=*}
  [[ $name == CI_CACHE_SANDBOX_KEY_* ]] || continue
  value=${line#*=}
  value=${value//\"/}
  value=${value//\'/}
  if grep -qxF -- "$(printf '%s' "$value" | sha256)" <<<"$old_hashes"; then stale_vars+=("$name"); fi
done <"$env_file"
unset line value

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
jq --argjson entry "$entry" --arg old "$old_hashes" \
  '($old | split("\n")) as $drop | with_entries(select(.key as $k | $drop | index($k) | not)) + $entry' "$map_file" >"$tmp_map"
cp "$env_file" "$tmp_env"
for name in "$var" ${stale_vars[@]+"${stale_vars[@]}"}; do
  grep -v "^$name=" "$tmp_env" >"$tmp_env.next" || true
  mv "$tmp_env.next" "$tmp_env"
done
printf '%s=%s\n' "$var" "$key" >>"$tmp_env"
unset key entry
chmod 600 "$tmp_map" "$tmp_env"
mv "$tmp_map" "$map_file"
mv "$tmp_env" "$env_file"
trap - EXIT

count=$(jq 'length' "$map_file")
per_repo=$(jq --argjson id "$repo_id" '[.[] | select(.repoId == $id)] | length' "$map_file")
echo "ci-cache: sandbox key for $repo (id $repo_id), label '$label', stored as $var in $env_file"
if [[ -n $old_hashes ]]; then echo "ci-cache: the replaced key's entry was removed from the map"; fi
echo "ci-cache: $repo now has $per_repo sandbox key(s): $(jq -r --argjson id "$repo_id" '[.[] | select(.repoId == $id) | .label] | sort | join(", ")' "$map_file")"
echo "ci-cache: $map_file now holds $count entries: $(jq -r '[.[] | .repo] | sort | join(", ")' "$map_file")"
label_flag=""
if [[ $label != "$DEFAULT_LABEL" ]]; then label_flag=" --label $label"; fi
cat <<EOF

Next (both write to shared infrastructure: confirm with the Worker's owner first):
  1. Upload the FULL map (it replaces the secret):
       cd "$engine" && pnpm wrangler secret put SANDBOX_KEYS < "$map_file"
  2. Give the sandbox the key as CI_CACHE_SANDBOX_KEY, from stdin and never on screen: in
     your provider's secret store (the value is \$$var in $env_file), or, in
     Boat (connect-sandbox.sh$label_flag does this), output redacted:
       ( set +x; . "$env_file"; printf '%s' "\${$var}" ) |
         boat env set-var <env> CI_CACHE_SANDBOX_KEY 2>&1 | sed -E 's/sk_[A-Za-z0-9_-]+/sk_***/g'
       boat env upgrade <env>
EOF
