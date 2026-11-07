#!/usr/bin/env bash
# Audit a repo before onboarding it onto ci-cache: which stacks it has, which cache steps
# its workflows use (and in what order), what would break cache-key parity, and how full
# its GitHub Actions cache is (10 GB per repo, least recently used evicted first).
#
#   audit-cache.sh <repo-dir> [owner/repo]
#
# Read-only. With owner/repo it also calls the GitHub API (2 calls + cache list pages).
set -uo pipefail

[[ $# -ge 1 && -d $1 ]] || { sed -n '2,8s/^# \{0,1\}//p' "$0" >&2; exit 2; }
dir=$(cd "$1" && pwd)
repo=${2:-}
wf_dir=$dir/.github/workflows
note() { printf '  - %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

workflows=()
if [[ -d $wf_dir ]]; then
  while IFS= read -r f; do workflows+=("$f"); done < <(find "$wf_dir" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
fi
# grep across the workflows, as relative file:line: text
wgrep() {
  ((${#workflows[@]})) || return 1
  grep -H -n -E "$@" "${workflows[@]}" | sed "s#^$dir/##"
}

echo "== stacks in $dir"
found=() # list of stacks for the summary
cargo=$(find "$dir" -maxdepth 3 -name Cargo.toml -not -path '*/node_modules/*' -not -path '*/target/*' | head -50)
if [[ -n $cargo ]]; then
  found+=(rust)
  note "Rust: $(printf '%s\n' "$cargo" | wc -l | tr -d ' ') Cargo.toml (depth <= 3; the setup action's sccache: auto sees them)"
  tc=$(cat "$dir/rust-toolchain.toml" "$dir/rust-toolchain" 2>/dev/null | grep -E '^\s*channel' | head -1)
  if [[ -z $tc ]]; then
    warn "no rust-toolchain(.toml) channel: sandbox and CI may run different compilers"
  elif [[ $tc =~ \"(stable|beta|nightly)\" ]]; then
    warn "toolchain floats ($tc): pin an exact version so both sides compile with the same rustc"
  else
    note "toolchain pinned: $tc"
  fi
  if [[ -f $dir/.cargo/config.toml ]] && grep -q -E 'rustflags|\[term\]' "$dir/.cargo/config.toml"; then
    note ".cargo/config.toml sets flags (shared by both sides; RUSTFLAGS in env overrides build.rustflags)"
  fi
fi
if [[ -f $dir/package.json ]]; then
  pm=npm
  [[ -f $dir/pnpm-lock.yaml ]] && pm=pnpm
  [[ -f $dir/yarn.lock ]] && pm=yarn
  [[ -f $dir/bun.lock || -f $dir/bun.lockb ]] && pm=bun
  if [[ -f $dir/turbo.json ]]; then
    found+=(turbo)
    tv=$(grep -o '"turbo": *"[^"]*"' "$dir/package.json" | head -1)
    note "Turbo: turbo.json, package manager $pm, ${tv:-turbo not pinned in the root package.json}"
    grep -q -E '"signature" *: *true' "$dir/turbo.json" && warn "remoteCache.signature is on: sandbox and CI need the same TURBO_REMOTE_CACHE_SIGNATURE_KEY"
  else
    found+=(node)
    note "Node ($pm) without turbo.json: ci-cache has nothing to serve here beyond the package manager's own cache"
  fi
fi
if [[ -f $dir/go.mod ]] || [[ -n $(find "$dir" -maxdepth 3 -name go.mod -not -path '*/node_modules/*' -print -quit) ]]; then
  found+=(go)
  note "Go: go.mod found; ci-cache has no Go backend yet (GOCACHEPROG is v2): keep setup-go's cache"
fi
dockerfiles=$(find "$dir" -maxdepth 4 \( -name Dockerfile -o -name '*.Dockerfile' -o -name 'Dockerfile.*' \) -not -path '*/node_modules/*' | sed "s#^$dir/##")
if [[ -n $dockerfiles ]]; then
  found+=(docker)
  note "Docker: $(printf '%s' "$dockerfiles" | tr '\n' ' ')"
  if [[ ! -f $dir/.dockerignore ]]; then
    warn "no .dockerignore: every file is in the build context, any change rebuilds the image"
  elif head -5 "$dir/.dockerignore" | grep -q -E '^\*\s*$'; then
    note ".dockerignore is an allowlist (starts with *)"
  else
    note ".dockerignore is a denylist: new root-level files (CI config dirs) enter the context"
  fi
fi
((${#found[@]})) || note "no Rust, Turbo, Go or Docker found"

echo
echo "== cache steps in .github/workflows"
if ((${#workflows[@]} == 0)); then
  note "no workflows"
else
  for pattern in 'OmarAlex24/ci-cache/setup' 'id-token: *write' 'mount-workdir' 'Swatinem/rust-cache' \
    'prefix-key|cache-targets|save-if' 'mozilla-actions/sccache-action|RUSTC_WRAPPER|SCCACHE_' \
    'actions/cache(/restore|/save)?@' 'cache: *(pnpm|npm|yarn|true)|cache-dependency-path' \
    'TURBO_(TOKEN|TEAM|API|REMOTE_ONLY|CACHE)' 'docker (buildx )?build|docker/build-push-action' \
    'cache-(from|to)|type=gha|type=registry' 'RUSTFLAGS|CARGO_[A-Z_]+:' 'head\.repo\.full_name' \
    'cancel-in-progress'; do
    hits=$(wgrep "$pattern")
    [[ -n $hits ]] || continue
    echo "  [$pattern]"
    printf '%s\n' "$hits" | sed -E 's/^/    /; s/[[:space:]]+$//' | cut -c1-160 | head -12
  done
fi

echo
echo "== checks"
for f in "${workflows[@]}"; do
  rel=${f#"$dir"/}
  rc=$(grep -n 'Swatinem/rust-cache' "$f" | head -1 | cut -d: -f1)
  cc=$(grep -n 'OmarAlex24/ci-cache/setup' "$f" | head -1 | cut -d: -f1)
  if [[ -n $rc && -n $cc && $rc -lt $cc ]]; then
    warn "$rel: rust-cache (line $rc) runs before ci-cache (line $cc): RUSTC_WRAPPER is not in its key"
  fi
  if [[ -n $rc ]] && ! grep -q -E 'cache-targets: *false' "$f"; then
    warn "$rel: rust-cache caches target/ (cache-targets is not false): a foreign target/ breaks sccache keys"
  fi
  if [[ -n $cc ]] && ! grep -q -E 'id-token: *write' "$f"; then
    warn "$rel: uses ci-cache but grants no id-token: write"
  fi
  if [[ -n $cc ]] && ! grep -q -E 'mount-workdir: *"?true' "$f" && [[ " ${found[*]} " == *" rust "* ]]; then
    warn "$rel: ci-cache without mount-workdir: CI builds at another path than the sandboxes"
  fi
  if grep -q -E 'TURBO_TOKEN: *\$\{\{ *secrets\.' "$f"; then
    warn "$rel: TURBO_TOKEN from a secret (Vercel?): remove it when moving to ci-cache"
  fi
  if grep -q -E 'cache-from' "$f" && ! grep -q -E 'without (it|the cache)|uncached|--no-cache|cache=\(\)' "$f"; then
    warn "$rel: docker build with a cache and no visible uncached retry (ignore-error covers only the export)"
  fi
done
[[ " ${found[*]} " == *" rust "* ]] && ! wgrep 'OmarAlex24/ci-cache/setup' >/dev/null && note "Rust present and no ci-cache step yet: start with references/rust.md"

if [[ -n $repo ]]; then
  echo
  echo "== GitHub ($repo)"
  owner=${repo%%/*}
  if [[ $(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]') != omaralex24 ]]; then
    warn "owner $owner is not in the Worker's ALLOWED_OWNERS (OmarAlex24): /v1/session will answer 403"
  fi
  if id=$(gh api "repos/$repo" --jq .id 2>/dev/null); then note "repo id: $id (the 'repo' parameter of /v1/stats)"; fi
  if usage=$(gh api "repos/$repo/actions/cache/usage" 2>/dev/null); then
    bytes=$(jq -r '.active_caches_size_in_bytes' <<<"$usage")
    count=$(jq -r '.active_caches_count' <<<"$usage")
    gb=$(awk -v b="$bytes" 'BEGIN { printf "%.2f", b / 1e9 }')
    note "Actions cache: $gb GB in $count entries (limit 10 GB per repo)"
    awk -v b="$bytes" 'BEGIN { exit !(b > 8e9) }' && warn "over ~8 GB: new entries will evict others; propose deleting stale prefixes (with Omar's OK)"
    list=$(gh cache list -R "$repo" --limit 1000 --json key,sizeInBytes,ref,lastAccessedAt 2>/dev/null || echo '[]')
    echo "  by key prefix (hashes stripped):"
    jq -r '.[] | [.key, .sizeInBytes] | @tsv' <<<"$list" |
      sed -E 's/-(sha256:)?[0-9a-f]{8,}[^\t]*\t/\t/' |
      awk -F'\t' '{ s[$1] += $2; n[$1]++ } END { for (k in s) printf "%10.1f MB  %4d  %s\n", s[k] / 1048576, n[k], k }' |
      sort -rn | head -12 | sed 's/^/    /'
    echo "  by ref:"
    jq -r '.[] | [.ref, .sizeInBytes] | @tsv' <<<"$list" |
      awk -F'\t' '{ s[$1] += $2; n[$1]++ } END { for (k in s) printf "%10.1f MB  %4d  %s\n", s[k] / 1048576, n[k], k }' |
      sort -rn | head -10 | sed 's/^/    /'
  else
    warn "could not read the Actions cache usage (token scope?)"
  fi
fi
