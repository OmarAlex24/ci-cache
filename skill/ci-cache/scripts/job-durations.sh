#!/usr/bin/env bash
# First-attempt job durations (completed_at - started_at, from the jobs API) for recent
# runs of one workflow, plus n / median / min / max. Reruns are excluded on purpose: a
# rerun skips tasks and lands on a warm machine, so it is not comparable.
#
#   job-durations.sh <owner/repo> [--workflow ci.yml] [--job ci] [--event pull_request|push]
#                    [--branch <name>] [--limit 20] [--all]
#
#   --job     job name to time (default: every job with a runner, one row each)
#   --all     include runs that did not succeed (default: conclusion == success only)
#
# One API call per run: keep --limit modest (the GitHub quota is 5,000 calls/h).
# Output: TSV rows (run, created, event, branch, job, seconds, runner), then a summary.
set -euo pipefail

usage() { sed -n '2,13s/^# \{0,1\}//p' "$0" >&2; exit 2; }

repo="" workflow=ci.yml job="" event="" branch="" limit=20 all=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --workflow) workflow=$2; shift 2 ;;
    --job) job=$2; shift 2 ;;
    --event) event=$2; shift 2 ;;
    --branch) branch=$2; shift 2 ;;
    --limit) limit=$2; shift 2 ;;
    --all) all=true; shift ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) repo=$1; shift ;;
  esac
done
[[ $repo == */* ]] || usage
[[ $limit =~ ^[1-9][0-9]*$ ]] || { echo "bad --limit" >&2; exit 2; }

args=(-R "$repo" --workflow "$workflow" --limit "$limit" --json "databaseId,createdAt,event,headBranch,conclusion,status")
[[ -n $event ]] && args+=(--event "$event")
[[ -n $branch ]] && args+=(--branch "$branch")

runs=$(gh run list "${args[@]}" --jq \
  ".[] | select(.status == \"completed\") | select($all or .conclusion == \"success\")
   | [.databaseId, .createdAt, .event, .headBranch] | @tsv")
[[ -n $runs ]] || { echo "no matching completed runs" >&2; exit 1; }

rows=$(mktemp)
trap 'rm -f "$rows"' EXIT
while IFS=$'\t' read -r id created ev br; do
  # attempts/1: the first attempt only, even when the run was rerun later.
  if ! jobs=$(gh api "repos/$repo/actions/runs/$id/attempts/1/jobs?per_page=100" 2>/dev/null); then
    echo "run $id: could not read its jobs" >&2
    continue
  fi
  # Jobs with a runner only: API-created check runs show up as pseudo-jobs without one.
  jq -r --arg job "$job" --arg id "$id" --arg created "$created" --arg ev "$ev" --arg br "$br" '
    .jobs[] | select(.runner_name != null and .runner_name != "" and .started_at != null and .completed_at != null)
    | select($job == "" or .name == $job)
    | [$id, $created, $ev, $br, .name,
       ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601)), .runner_name] | @tsv' \
    <<<"$jobs" >>"$rows"
done <<<"$runs"

printf 'run\tcreated\tevent\tbranch\tjob\tseconds\trunner\n'
cat "$rows"
echo
awk -F'\t' '
  { s[$5] = s[$5] " " $6 }
  END {
    for (j in s) {
      n = split(substr(s[j], 2), v, " ")
      # insertion sort: n is small
      for (i = 2; i <= n; i++) { x = v[i] + 0; k = i - 1; while (k > 0 && v[k] + 0 > x) { v[k + 1] = v[k]; k-- } v[k + 1] = x }
      med = (n % 2) ? v[(n + 1) / 2] : (v[n / 2] + v[n / 2 + 1]) / 2
      printf "%s: n=%d median=%.0f s (%.1f min) min=%d max=%d%s\n", j, n, med, med / 60, v[1], v[n], (n < 5 ? "  <- fewer than 5 runs: no verdict yet" : "")
    }
  }' "$rows"
