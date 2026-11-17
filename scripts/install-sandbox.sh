#!/usr/bin/env bash
# Installs ci-cache's sandbox side into ~/.ci-cache/ on any machine where an agent builds:
# ci-cache-env.sh (the session and the exports), cache-fingerprint.sh (uploaded after each
# session so CI can compare it) and, with --rust, the sccache installer, which it then runs.
# Every file is checked against the SHA-256 below before anything is installed.
#
#   ref=<commit SHA of OmarAlex24/ci-cache>   # pin a full SHA (or, later, a release tag)
#   curl -fsSL "https://raw.githubusercontent.com/OmarAlex24/ci-cache/$ref/scripts/install-sandbox.sh" |
#     bash -s -- --ref "$ref" [--rust]
#
#   bash scripts/install-sandbox.sh [--rust]   # from a checkout: copies its own files
#
# Options:
#   --ref <sha|tag>  the ref to download the files from; the same one as in the URL above.
#                    Not needed when run from a checkout (it copies the files next to it).
#   --rust           also install sccache (Linux x86_64/aarch64, SHA-256 checked, the same
#                    version CI uses) into ~/.local/bin
#   --dir <path>     where to install (default ~/.ci-cache)
#   --check-sums     (maintainers) exit 1 if the sums below don't match this checkout
#
# Env: CI_CACHE_SOURCE  base URL of the raw files (default
#      https://raw.githubusercontent.com/OmarAlex24/ci-cache; a fork's works too)
#
# Then, with CI_CACHE_URL and CI_CACHE_SANDBOX_KEY in the sandbox's environment:
#   bash ~/.ci-cache/ci-cache-env.sh && source ~/.ci-cache.env
set -euo pipefail

# SHA-256 of each file at the same commit as this script. `pnpm lint:sh` runs --check-sums,
# so a change to one of these files has to update its line here in the same commit.
SUMS='
fd5e2a93a2170661e0b51d415cf353ac1386cd89b9f96e16a67a49037cdacee0  scripts/ci-cache-env.sh
c4b30c3df9879062d7a39f5ae54f7473d6f75a098c267f648f8dde05bc3bba86  scripts/cache-fingerprint.sh
6947523353bf7138b50b67bff3d8771d437a366c7f59dc0839a2e86db36a078c  skill/ci-cache/templates/sandbox-install-sccache.sh
'

fail() {
  echo "ci-cache install: $*" >&2
  exit 1
}
usage() {
  sed -n '2,27s/^# \{0,1\}//p' "${BASH_SOURCE[0]}" >&2
  exit 2
}
sha256() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
expected() { # <path in the repo>
  awk -v p="$1" '$2 == p { print $1 }' <<<"$SUMS"
}

ref="" rust=false dest=${HOME:?}/.ci-cache check=false
while (($#)); do
  case $1 in
    --ref) ref=${2:-}; shift 2 ;;
    --rust) rust=true; shift ;;
    --dir) dest=${2:-}; shift 2 ;;
    --check-sums) check=true; shift ;;
    -h | --help) usage ;;
    *) echo "ci-cache install: unknown option $1" >&2; usage ;;
  esac
done
[[ -n $dest ]] || fail "--dir needs a path"

# A checkout: this script sits in <repo>/scripts/ next to the files it installs.
here=""
if [[ -f ${BASH_SOURCE[0]:-} ]]; then
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  [[ -f $here/scripts/ci-cache-env.sh ]] || here=""
fi

if $check; then
  [[ -n $here ]] || fail "--check-sums runs from a checkout"
  bad=0
  while read -r sum path; do
    [[ -n $path ]] || continue
    actual=$(sha256 "$here/$path")
    if [[ $actual != "$sum" ]]; then
      echo "ci-cache install: $path changed: put this line in SUMS: $actual  $path" >&2
      bad=1
    fi
  done <<<"$SUMS"
  exit "$bad"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Fetch (or copy) every file into $tmp, then verify all of them, then install: a mismatch
# installs nothing.
fetch() { # <path in the repo> <name in $tmp>
  local path=$1 name=$2
  if [[ -n $here && -z $ref ]]; then
    cp "$here/$path" "$tmp/$name"
  else
    [[ -n $ref ]] || fail "--ref <commit SHA or tag> is required when not run from a checkout"
    [[ $ref =~ ^[A-Za-z0-9._/-]+$ ]] || fail "--ref looks wrong: $ref"
    local base=${CI_CACHE_SOURCE:-https://raw.githubusercontent.com/OmarAlex24/ci-cache}
    curl -fsSL --retry 3 -o "$tmp/$name" "${base%/}/$ref/$path" || fail "could not download $path at $ref"
  fi
  local want got
  want=$(expected "$path")
  got=$(sha256 "$tmp/$name")
  [[ -n $want && $got == "$want" ]] ||
    fail "$path does not match its SHA-256 (expected ${want:-none}, got $got): nothing installed. Is --ref the same commit as this installer?"
}
fetch scripts/ci-cache-env.sh ci-cache-env.sh
fetch scripts/cache-fingerprint.sh cache-fingerprint.sh
if $rust; then fetch skill/ci-cache/templates/sandbox-install-sccache.sh install-sccache.sh; fi

mkdir -p "$dest"
installed=""
for name in ci-cache-env.sh cache-fingerprint.sh install-sccache.sh; do
  [[ -f $tmp/$name ]] || continue
  install -m 0755 "$tmp/$name" "$dest/$name"
  installed+=" $name"
done
echo "ci-cache: installed in $dest:$installed (SHA-256 checked)"

if $rust; then
  bash "$dest/install-sccache.sh" || fail "installing sccache failed (above); ci-cache-env.sh still works, for Turbo only"
fi

cat <<EOF
ci-cache: next, with CI_CACHE_URL and CI_CACHE_SANDBOX_KEY in this sandbox's environment, in the repo:
  bash $dest/ci-cache-env.sh && source ~/.ci-cache.env
then 'source ~/.ci-cache.env' in every shell that builds (it renews the session by itself).
EOF
