#!/usr/bin/env bash
# Reads ci-cache metrics for one repo: /v1/stats (hit rates per tier, kind, protocol) and
# /v1/stats/branches (how much of what a sandbox wrote the branch's CI reused).
#
#   cache-stats.sh <owner/repo | repoId> [--range 1h|24h|7d|30d|90d] [--branch <name>] [--json]
#
# Env:
#   CI_CACHE_URL        Worker URL (default https://ci-cache.omarespinosafernandez.workers.dev)
#   CI_CACHE_STATS_KEY  rk_ key; if unset, read from $CI_CACHE_KEYS_DIR/keys.env
#   CI_CACHE_KEYS_DIR   default ~/.config/ci-cache
#
# The key goes to curl through stdin (-H @-): never on the command line, never printed.
set -euo pipefail
set +x

usage() { sed -n '2,13s/^# \{0,1\}//p' "$0" >&2; exit 2; }

target="" range=7d branch="" json=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --range) range=${2:-}; shift 2 ;;
    --branch) branch=${2:-}; shift 2 ;;
    --json) json=true; shift ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) target=$1; shift ;;
  esac
done
[[ -n $target ]] || usage
case $range in 1h | 24h | 7d | 30d | 90d) ;; *) echo "bad --range: $range" >&2; exit 2 ;; esac
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

url=${CI_CACHE_URL:-https://ci-cache.omarespinosafernandez.workers.dev}
url=${url%/}
if [[ $target =~ ^[1-9][0-9]*$ ]]; then
  repo_id=$target
else
  repo_id=$(gh api "repos/$target" --jq .id) || { echo "could not resolve the id of $target" >&2; exit 1; }
fi

key=${CI_CACHE_STATS_KEY:-}
if [[ -z $key ]]; then
  env_file=${CI_CACHE_KEYS_DIR:-$HOME/.config/ci-cache}/keys.env
  [[ -r $env_file ]] || { echo "no CI_CACHE_STATS_KEY and no $env_file" >&2; exit 1; }
  key=$(sed -n 's/^CI_CACHE_STATS_KEY=//p' "$env_file" | head -1)
  key=${key//\"/}
  key=${key//\'/}
fi
[[ $key == rk_* ]] || { echo "the stats key must be an rk_ key" >&2; exit 1; }

echo "ci-cache stats: $url, repo $target (id $repo_id), range $range" >&2

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
get() {
  local path=$1 out=$2 status
  status=$(printf 'Authorization: Bearer %s\n' "$key" |
    curl -sS --retry 2 -H @- -o "$out" -w '%{http_code}' "$url$path?repo=$repo_id&range=$range") ||
    { echo "could not reach $url" >&2; exit 1; }
  if [[ $status != 200 ]]; then
    echo "GET $path answered $status: $(jq -r '.message // empty' "$out" 2>/dev/null)" >&2
    exit 1
  fi
}
get /v1/stats "$tmp/stats.json"
get /v1/stats/branches "$tmp/branches.json"
unset key

if [[ $json == true ]]; then
  jq -n --slurpfile s "$tmp/stats.json" --slurpfile b "$tmp/branches.json" '{stats: $s[0], branches: $b[0]}'
  exit 0
fi

render_stats() {
  jq -r '
    def pct: if . == null then "-" else "\(. * 1000 | round / 10) %" end;
    def mb: "\(. / 1048576 * 10 | round / 10) MB";
    def row($name; $c): "\($name)\t\($c.requests)\t\($c.hits)\t\($c.hitsFromMain)\t\($c.misses)\t\($c.writes)\t\($c.hitRate | pct)\t\($c.bytesRead | mb)\t\($c.bytesWritten | mb)";
    "scope\trequests\thits\tfrom-main\tmisses\twrites\thit-rate\tread\twritten",
    row("total"; .totals),
    (.byTier | to_entries[] | select(.value.requests > 0) | row("tier:" + .key; .value)),
    (.byKind | to_entries[] | select(.value.requests > 0) | row("kind:" + .key; .value)),
    (.byProtocol | to_entries[] | select(.value.requests > 0) | row("protocol:" + .key; .value))
  ' "$tmp/stats.json"
}

render_branches() {
  jq -r --arg branch "$branch" '
    # reuseAlert is also true on a branch CI never read (a sandbox-only branch): say so.
    def ratio: if .sandboxWrites == 0 then "-" elif .ciReads == 0 then "no-ci" else "\(.ciHitsOnSandboxObjects / .sandboxWrites * 1000 | round / 10) %" end;
    "branch\tsandbox-writes\tci-reads\tci-hits\tci-hits-on-sandbox-objects\treuse\treuseAlert",
    (.branches[] | select($branch == "" or .branch == $branch)
      | "\(.branch)\t\(.sandboxWrites)\t\(.ciReads)\t\(.ciHits)\t\(.ciHitsOnSandboxObjects)\t\(ratio)\t\(.reuseAlert)")
  ' "$tmp/branches.json"
}

table() { if command -v column >/dev/null; then column -t -s $'\t'; else cat; fi; }
render_stats | table
echo "time saved (Turbo only): $(jq '.totals.timeSavedMs / 1000 | round' "$tmp/stats.json") s"
echo
render_branches | table
echo
echo "reuse = ci-hits-on-sandbox-objects / sandbox-writes (no-ci: CI never read that branch)."
echo "reuseAlert fires at >= $(jq .reuseAlertMinWrites "$tmp/branches.json") sandbox writes with 0 reused, also when CI never ran there."
