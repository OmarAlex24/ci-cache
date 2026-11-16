#!/usr/bin/env bash
# Main step of setup/action.yml. Reads its inputs from INPUT_* (see action.yml).
# Never prints tokens: they are masked with ::add-mask:: before any other output.
set -euo pipefail

# SHA-256 of the official sccache tarballs for the default version
# (https://github.com/mozilla/sccache/releases/tag/v0.19.0, verified against the .sha256 files).
DEFAULT_SCCACHE_VERSION=0.19.0
DEFAULT_SCCACHE_SHA256_X86_64=aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd
DEFAULT_SCCACHE_SHA256_AARCH64=3e47fc4a71b1ddd1b4294a0de9d34498922fdf41e3cd0bda5df3954e3d6deb9d

fail() {
  echo "::error title=ci-cache::$*"
  exit 1
}

# Reads a text field from a flat JSON object (jq if available; otherwise python3).
json_field() {
  local field=$1 file=$2
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg f "$field" '.[$f] // empty' "$file"
  else
    python3 -c 'import json,sys; v=json.load(open(sys.argv[2])).get(sys.argv[1]); print("" if v is None else v)' "$field" "$file"
  fi
}

url=${INPUT_URL%/}
audience=${INPUT_AUDIENCE:-ci-cache}
[[ $url =~ ^https?://[^[:space:]]+$ ]] || fail "invalid input url: '$url'"
[[ -n ${GITHUB_ENV:-} && -n ${GITHUB_OUTPUT:-} && -n ${GITHUB_REPOSITORY:-} ]] || fail "this must run inside GitHub Actions"
if [[ -z ${ACTIONS_ID_TOKEN_REQUEST_URL:-} || -z ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} ]]; then
  fail "no OIDC token: add 'permissions: id-token: write' to the job"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. GitHub OIDC token with the Worker's audience.
curl -fsS --retry 3 -G \
  -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  --data-urlencode "audience=$audience" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL" -o "$tmp/oidc.json" || fail "could not request the OIDC token from GitHub"
oidc=$(json_field value "$tmp/oidc.json")
[[ -n $oidc ]] || fail "GitHub did not return an OIDC token"
echo "::add-mask::$oidc"

# 2. Session on the Worker. The Worker decides the tier from the OIDC token.
status=$(curl -sS --retry 3 -X POST -H "Authorization: Bearer $oidc" \
  -o "$tmp/session.json" -w '%{http_code}' "$url/v1/session") || fail "could not reach $url"
if [[ $status != 200 ]]; then
  fail "POST /v1/session answered $status: $(json_field message "$tmp/session.json" 2>/dev/null || true)"
fi
token=$(json_field token "$tmp/session.json")
[[ -n $token ]] || fail "session response without a token"
echo "::add-mask::$token"
tier=$(json_field tier "$tmp/session.json")
branch=$(json_field branch "$tmp/session.json")
expires=$(json_field expiresAt "$tmp/session.json")

repo_name=${GITHUB_REPOSITORY#*/}
{
  echo "TURBO_API=$url"
  echo "TURBO_TOKEN=$token"
  # turbo requires a team; the Worker ignores it (the prefix comes from the token).
  echo "TURBO_TEAM=$repo_name"
  # On a 403 turbo turns off the remote cache for the whole run: main-ro uses it read-only.
  if [[ $tier == main-ro ]]; then echo "TURBO_CACHE=local:rw,remote:r"; fi
} >>"$GITHUB_ENV"
echo "ci-cache: session $tier (branch $branch) until $expires"

# 3. Working directory: optionally the same path Boat sandboxes use.
workdir=$GITHUB_WORKSPACE
if [[ ${INPUT_MOUNT_WORKDIR:-false} == true ]]; then
  workdir=/home/user/$repo_name
  if mountpoint -q "$workdir" 2>/dev/null; then
    echo "ci-cache: $workdir is already mounted"
  else
    sudo mkdir -p "$workdir"
    if [[ -n $(sudo ls -A "$workdir") ]]; then fail "$workdir exists and is not empty"; fi
    sudo mount --bind "$GITHUB_WORKSPACE" "$workdir"
    echo "ci-cache: checkout mounted at $workdir"
  fi
fi

# 4. sccache if there is Rust.
want_sccache=${INPUT_SCCACHE:-auto}
if [[ $want_sccache == auto ]]; then
  # -print -quit instead of `| grep -q`: with pipefail, find's SIGPIPE would give a false negative.
  if [[ -n $(find "$GITHUB_WORKSPACE" -maxdepth 3 -name Cargo.toml -not -path '*/node_modules/*' -not -path '*/target/*' -print -quit) ]]; then
    want_sccache=true
  else
    want_sccache=false
  fi
fi
if [[ $want_sccache == true ]]; then
  version=${INPUT_SCCACHE_VERSION:-$DEFAULT_SCCACHE_VERSION}
  [[ $(uname -s) == Linux ]] || fail "installing sccache is only supported on Linux"
  case $(uname -m) in
    x86_64 | amd64) arch=x86_64 default_sha=$DEFAULT_SCCACHE_SHA256_X86_64 ;;
    aarch64 | arm64) arch=aarch64 default_sha=$DEFAULT_SCCACHE_SHA256_AARCH64 ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  sha=${INPUT_SCCACHE_SHA256:-}
  if [[ -z $sha ]]; then
    [[ $version == "$DEFAULT_SCCACHE_VERSION" ]] || fail "sccache-version $version requires sccache-sha256"
    sha=$default_sha
  fi
  [[ $sha =~ ^[0-9a-f]{64}$ ]] || fail "invalid sccache-sha256"

  dest=${RUNNER_TOOL_CACHE:-$HOME/.local/share}/sccache/$version/$arch
  if [[ -x $dest/sccache ]]; then
    echo "ci-cache: sccache $version already installed in $dest"
  else
    name=sccache-v$version-$arch-unknown-linux-musl
    curl -fsSL --retry 3 -o "$tmp/$name.tar.gz" \
      "https://github.com/mozilla/sccache/releases/download/v$version/$name.tar.gz" || fail "could not download sccache $version"
    echo "$sha  $tmp/$name.tar.gz" | sha256sum -c --quiet - || fail "the sccache SHA-256 does not match"
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
    mkdir -p "$dest"
    install -m 0755 "$tmp/$name/sccache" "$dest/sccache"
  fi
  echo "$dest" >>"$GITHUB_PATH"
  # If the remote cache fails the check the sccache server runs at startup, the server
  # doesn't start and every rustc exits with an error: the run would turn red instead of
  # just slower. So it is started here and, if that fails, it is not enabled.
  if SCCACHE_WEBDAV_ENDPOINT="$url/dav" SCCACHE_WEBDAV_TOKEN="$token" SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true \
    "$dest/sccache" --start-server >/dev/null 2>&1; then
    {
      echo "RUSTC_WRAPPER=sccache"
      echo "SCCACHE_WEBDAV_ENDPOINT=$url/dav"
      echo "SCCACHE_WEBDAV_TOKEN=$token"
      # R2 has no directories: without this sccache sends a PROPFIND before every PUT.
      echo "SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true"
      # sccache doesn't cache incremental compilation.
      echo "CARGO_INCREMENTAL=0"
    } >>"$GITHUB_ENV"
    echo "ci-cache: sccache $version ready"
  else
    echo "::warning::ci-cache: sccache did not start against the remote cache; this run builds without sccache"
  fi
fi

{
  echo "tier=$tier"
  echo "branch=$branch"
  echo "expires-at=$expires"
  echo "workdir=$workdir"
} >>"$GITHUB_OUTPUT"
