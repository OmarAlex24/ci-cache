#!/usr/bin/env bash
# Installs the sccache that ci-cache's CI uses into ~/.local/bin, so ci-cache-env.sh
# exports RUSTC_WRAPPER. The Boat image ships cargo but no sccache. Idempotent: it does
# nothing when that version is already there. Linux only.
#
#   bash ~/.ci-cache/install-sccache.sh
#
# connect-sandbox.sh delivers this file into Boat sandboxes as ~/.ci-cache/install-sccache.sh
# and refuses to when the version or the SHA-256 below differ from the engine's
# setup/setup.sh: CI and sandboxes must run the same sccache.
set -euo pipefail

SCCACHE_VERSION=0.19.0
SCCACHE_SHA256_X86_64=aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd
SCCACHE_SHA256_AARCH64=3e47fc4a71b1ddd1b4294a0de9d34498922fdf41e3cd0bda5df3954e3d6deb9d

dest=${CI_CACHE_BIN_DIR:-$HOME/.local/bin}

fail() {
  echo "ci-cache: $*" >&2
  exit 1
}

if [[ -x $dest/sccache && $("$dest/sccache" --version 2>/dev/null) == "sccache $SCCACHE_VERSION" ]]; then
  exit 0
fi

[[ $(uname -s) == Linux ]] || fail "this installer supports Linux only"
case $(uname -m) in
  x86_64 | amd64) arch=x86_64 sha=$SCCACHE_SHA256_X86_64 ;;
  aarch64 | arm64) arch=aarch64 sha=$SCCACHE_SHA256_AARCH64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

name=sccache-v$SCCACHE_VERSION-$arch-unknown-linux-musl
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/$name.tar.gz" \
  "https://github.com/mozilla/sccache/releases/download/v$SCCACHE_VERSION/$name.tar.gz" ||
  fail "could not download sccache $SCCACHE_VERSION"
echo "$sha  $tmp/$name.tar.gz" | sha256sum -c --quiet - || fail "sccache SHA-256 mismatch"
tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
mkdir -p "$dest"
install -m 0755 "$tmp/$name/sccache" "$dest/sccache"

command -v sccache >/dev/null 2>&1 || echo "ci-cache: add $dest to PATH" >&2
echo "ci-cache: sccache $SCCACHE_VERSION installed in $dest"
