#!/usr/bin/env bash
# shellcheck disable=SC2016 # $n, $r and $v in single quotes are jq variables
# Connects a repo's Boat sandboxes to the ci-cache engine:
#   1. finds the Boat environment that holds the repo (or takes it as an argument);
#   2. sets CI_CACHE_URL and CI_CACHE_SANDBOX_KEY in it (values from stdin, never argv);
#   3. delivers three Boat secret files into ~/.ci-cache/ in the sandbox: the engine's
#      scripts/ci-cache-env.sh and scripts/cache-fingerprint.sh (ci-cache-env.sh uploads
#      its output for CI to compare) and this skill's templates/sandbox-install-sccache.sh
#      (the Boat image has cargo but no sccache);
#   4. runs `boat env upgrade` so live sandboxes get the new version.
#
#   connect-sandbox.sh <owner/repo> [env] [--dry-run] [--create-env] [--dir DIR]
#
#   env           Boat environment to change. Default: the one whose repos include
#                 <owner/repo>; else the one named like the repo. Refuses on ambiguity.
#                 Never picks the default environment (CI runners start from it) on
#                 its own: name it to change it.
#   --dry-run     discover and print every write, change nothing
#   --create-env  create [env] if it does not exist (boat env new); never implicit
#   --dir         in-sandbox directory for both files, relative to the sandbox home
#                 (default .ci-cache -> /home/user/.ci-cache). Boat writes them mode 644:
#                 run them with `bash`.
#
# Env:
#   CI_CACHE_URL       your Worker's URL (else read from $CI_CACHE_KEYS_DIR/url), e.g. https://ci-cache.<your-subdomain>.workers.dev
#   CI_CACHE_KEYS_DIR  key directory with keys.env (default ~/.config/ci-cache)
#   CI_CACHE_REPO      engine checkout with scripts/ci-cache-env.sh (default: the clone this
#                      skill lives in, when run from skill/ci-cache/ in that clone)
#   BOAT               boat binary (default: boat on PATH, else ~/.ascii/bin/boat)
#
# Secrets: `boat env list/info` print variable VALUES. This script only reads them as
# --json piped into jq filters that emit names (env names, variable names, repo names),
# and redacts sk_/rk_ in every line it prints. The key goes from keys.env to stdin of
# `boat env set-var` inside a subshell; it never reaches argv, a variable of this shell
# or the terminal.
set -euo pipefail
set +x # never trace this script: it moves a plaintext key

usage() {
  sed -n '3,31p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() {
  echo "connect-sandbox: $*" >&2
  exit 1
}
redact() { sed -E 's/(sk|rk)_[A-Za-z0-9_-]+/\1_***/g'; }

repo="" env_name="" dry_run=false create_env=false dir=.ci-cache
while (($#)); do
  case $1 in
    --dry-run) dry_run=true ;;
    --create-env) create_env=true ;;
    --dir)
      (($# >= 2)) || usage
      dir=$2
      shift
      ;;
    --dir=*) dir=${1#*=} ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      if [[ -z $repo ]]; then
        repo=$1
      elif [[ -z $env_name ]]; then
        env_name=$1
      else
        usage
      fi
      ;;
  esac
  shift
done
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ -z $env_name || $env_name =~ ^[A-Za-z0-9._-]+$ ]] || die "bad environment name: $env_name"
dir=${dir%/}
[[ -n $dir && $dir != /* && $dir != *..* ]] || die "--dir must be relative, without '..'"

# CI_CACHE_URL, else the url file next to keys.env (one line, the Worker's URL).
url=${CI_CACHE_URL:-$(cat "${CI_CACHE_KEYS_DIR:-$HOME/.config/ci-cache}/url" 2>/dev/null || true)}
[[ -n $url ]] || die "CI_CACHE_URL is not set: export your Worker's URL or put it in ~/.config/ci-cache/url (https://ci-cache.<your-subdomain>.workers.dev)"
url=${url%/}
[[ $url == https://* ]] || die "CI_CACHE_URL must be https"
keys_file=${CI_CACHE_KEYS_DIR:-$HOME/.config/ci-cache}/keys.env
skill_root=$(cd "$(dirname "$0")/.." && pwd)
# The engine checkout: CI_CACHE_REPO, or the clone this skill lives in (skill/ci-cache/).
engine=${CI_CACHE_REPO:-}
if [[ -z $engine && -f $skill_root/../../scripts/ci-cache-env.sh ]]; then engine=$(cd "$skill_root/../.." && pwd); fi
[[ -n $engine ]] || die "set CI_CACHE_REPO to your ci-cache checkout (it holds scripts/ci-cache-env.sh)"
env_script=$engine/scripts/ci-cache-env.sh
installer=$skill_root/templates/sandbox-install-sccache.sh

boat=${BOAT:-}
if [[ -z $boat ]]; then
  if command -v boat >/dev/null 2>&1; then boat=boat; else boat=$HOME/.ascii/bin/boat; fi
fi
command -v "$boat" >/dev/null 2>&1 || die "boat CLI not found (set BOAT)"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -f $env_script ]] || die "no $env_script (set CI_CACHE_REPO)"
[[ -f $keys_file ]] || die "no $keys_file"
[[ -f $installer ]] || die "no $installer"

# CI and sandboxes must run the same sccache: the installer's version and SHA-256 must
# equal the setup action's defaults.
for pin in VERSION SHA256_X86_64 SHA256_AARCH64; do
  want=$(sed -n "s/^DEFAULT_SCCACHE_$pin=//p" "$engine/setup/setup.sh")
  have=$(sed -n "s/^SCCACHE_$pin=//p" "$installer")
  [[ -n $want && $want == "$have" ]] ||
    die "SCCACHE_$pin in $installer differs from DEFAULT_SCCACHE_$pin in $engine/setup/setup.sh"
done

# my-repo -> CI_CACHE_SANDBOX_KEY_MY_REPO, app.web -> ..._APP_WEB (bash 3.2-safe).
key_var=CI_CACHE_SANDBOX_KEY_$(printf '%s' "${repo#*/}" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_')

# The key must exist and look like a sandbox key. Checked in a subshell: nothing leaks
# into this shell, and only the exit code comes back.
# shellcheck source=/dev/null
(set +x; . "$keys_file"; [[ ${!key_var:-} == sk_* ]]) ||
  die "$key_var is missing from $keys_file or is not an sk_ key (mint it: mint-sandbox-key.sh $repo)"

"$boat" env list --json --no-update >/dev/null 2>&1 || die "boat env list failed (signed in? try: $boat status)"

# Every read of Boat's environment goes through here: JSON only, a names-only jq filter,
# then the redaction. Never call `boat env list/info` any other way.
boat_env_names() { # <jq filter> [jq args...]
  local filter=$1
  shift
  "$boat" env list --json --no-update 2>/dev/null | jq -r "$@" "$filter" | redact
}

# Names of the non-default environments whose repos include $repo. The element shape of
# selectedRepositories is not documented: accept "owner/repo" strings, or objects with
# a fullName/full_name/repo field, and emit only the environment's name.
envs_with_repo() {
  boat_env_names '.environments[] | select(.isDefault != true)
    | select([.selectedRepositories[]?
        | if type == "string" then .
          elif type == "object" then (.fullName // .full_name // .repo // empty)
          else empty end
        | strings | ascii_downcase] | index($r | ascii_downcase))
    | .name' --arg r "$repo"
}
env_exists() { # <name>
  [[ -n $(boat_env_names '.environments[] | select(.name == $n) | .name' --arg n "$1") ]]
}

found_by="argument"
if [[ -z $env_name ]]; then
  matches=$(envs_with_repo)
  count=$(printf '%s' "$matches" | grep -c . || true)
  if ((count == 1)); then
    env_name=$matches found_by="its repos include $repo"
  elif ((count > 1)); then
    echo "Boat environments that include $repo:" >&2
    printf '%s\n' "$matches" | sed 's/^/  /' >&2
    die "several environments include $repo: pass the one to change as the second argument"
  elif [[ -n $(boat_env_names '.environments[] | select(.isDefault != true and .name == $n) | .name' --arg n "${repo#*/}") ]]; then
    env_name=${repo#*/} found_by="named like the repo (no environment lists $repo among its repos)"
  else
    die "no non-default Boat environment includes $repo or is named '${repo#*/}': pass one, with --create-env to create it"
  fi
fi

creating=false
if ! env_exists "$env_name"; then
  $create_env || die "Boat environment '$env_name' does not exist (add --create-env to create it)"
  creating=true
fi

# State by name only: variable names come out of the dotenv text with a regex that
# captures what is left of '='. Secret files are {path, contents}: only .path is read.
env_state() {
  boat_env_names '.environments[] | select(.name == $n)
    | "  version: \(.latestVersionNumber)",
      "  variables: \([.envContents // "" | scan("(?m)^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=") | .[0]] | join(", "))",
      "  secret files: \([.secretFiles[]? | objects | .path | strings] | join(", "))",
      "  repos: \([.selectedRepositories[]? | if type == "string" then . elif type == "object" then (.fullName // .full_name // .repo // "?") else "?" end] | join(", "))",
      "  live sandboxes: \([.versions[]?.sandboxCount // 0] | add // 0)"' --arg n "$env_name"
}
has_var() { # <name>
  [[ -n $(boat_env_names '.environments[] | select(.name == $n)
    | [.envContents // "" | scan("(?m)^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)=") | .[0]]
    | index($v) // empty' --arg n "$env_name" --arg v "$1") ]]
}

engine_rev=$(git -C "$engine" log -1 --format=%h -- scripts/ci-cache-env.sh 2>/dev/null || echo "?")
if ! git -C "$engine" diff --quiet HEAD -- scripts/ci-cache-env.sh 2>/dev/null; then
  engine_rev="$engine_rev+local changes"
fi

echo "repo:        $repo"
echo "Boat env:    $env_name ($found_by)"
echo "Worker:      $url"
echo "key:         CI_CACHE_SANDBOX_KEY from $key_var in $keys_file"
echo "files:       $env_script ($engine_rev) -> /home/user/$dir/ci-cache-env.sh"
echo "             $engine/scripts/cache-fingerprint.sh -> /home/user/$dir/cache-fingerprint.sh"
echo "             $installer -> /home/user/$dir/install-sccache.sh"
$dry_run && echo "mode:        dry run, nothing changes"
echo
if $creating; then
  echo "state before: environment '$env_name' does not exist yet"
else
  echo "state before:"
  env_state
  for v in CI_CACHE_URL CI_CACHE_SANDBOX_KEY; do
    if has_var "$v"; then echo "  $v: set (will be set again)"; else echo "  $v: missing"; fi
  done
fi
echo

# Every write goes through here. Its stdout never reaches the terminal raw: `boat env new`
# answers with EVERY environment in full, variable values included. Only the fields the
# filter names come out (counters, version numbers, environment names); stderr is redacted.
boat_write() { # <jq filter> <boat args...>
  local filter=$1
  shift
  "$boat" "$@" --json --no-update 2> >(redact >&2) | jq -c "$filter" | redact
}
version_only='{success, versionNumber}'

# Before every write: print the target and the command (names only, never a value).
step() { # <description> -- <boat args...>
  local what=$1
  shift 2
  echo "-> Boat env '$env_name': $what"
  if $dry_run; then echo "   (dry run) boat $*"; fi
}

if $creating; then
  step "create the environment" -- env new "$env_name"
  if ! $dry_run; then
    boat_write '{environments: [.environments[]?.name]}' env new "$env_name" || die "env new failed"
  fi
fi

step "set-var CI_CACHE_URL (value from stdin)" -- env set-var "$env_name" CI_CACHE_URL
if ! $dry_run; then
  printf '%s' "$url" | boat_write "$version_only" env set-var "$env_name" CI_CACHE_URL ||
    die "set-var CI_CACHE_URL failed"
fi

step "set-var CI_CACHE_SANDBOX_KEY (value from stdin: $key_var)" -- env set-var "$env_name" CI_CACHE_SANDBOX_KEY
if ! $dry_run; then
  # shellcheck source=/dev/null
  (set +x; . "$keys_file"; printf '%s' "${!key_var}") |
    boat_write "$version_only" env set-var "$env_name" CI_CACHE_SANDBOX_KEY ||
    die "set-var CI_CACHE_SANDBOX_KEY failed"
fi

# cache-fingerprint.sh goes next to ci-cache-env.sh, which uploads its output after each
# session so the branch's CI compares fingerprints on its own.
for pair in "ci-cache-env.sh:$env_script" "cache-fingerprint.sh:$engine/scripts/cache-fingerprint.sh" \
  "install-sccache.sh:$installer"; do
  target=$dir/${pair%%:*} source=${pair#*:}
  step "set-file $target (from $source)" -- env set-file "$env_name" "$target" --from "$source"
  if ! $dry_run; then
    boat_write "$version_only" env set-file "$env_name" "$target" --from "$source" ||
      die "set-file $target failed"
  fi
done

step "upgrade (push the new version to live sandboxes)" -- env upgrade "$env_name"
if ! $dry_run; then
  boat_write '{success, upgraded, upgradedLive, upgradedStopped, failed}' env upgrade "$env_name" ||
    die "upgrade failed"
fi

echo
if $dry_run; then
  echo "dry run: nothing changed"
  exit 0
fi
echo "state after:"
env_state
cat <<EOF

Next, in a sandbox started with --environment $env_name, from /home/user/${repo#*/}:
  bash ~/$dir/install-sccache.sh     # Rust repos only
  bash ~/$dir/ci-cache-env.sh && source ~/.ci-cache.env
Variables that enter cache keys (RUSTFLAGS, CARGO_*) must equal the CI workflow's env:.
EOF
