#!/usr/bin/env bash
# First-attempt job durations (completed_at - started_at, from the jobs API) for recent
# runs of one workflow, plus n / median / min / max. Reruns are excluded on purpose: a
# rerun skips tasks and lands on a warm machine, so it is not comparable.
#
#   job-durations.sh <owner/repo> [--workflow ci.yml] [--job ci] [--event pull_request|push]
#                    [--branch <name>] [--limit 20] [--all] [--compare <date|commit>]
#
#   --job      job name to time (default: every job with a runner, one row each)
#   --all      include runs that did not succeed (default: conclusion == success only)
#   --compare  before/after mode: up to --limit runs created before the date (YYYY-MM-DD,
#              or a full ISO 8601 time) or the commit (its committer date: when ci-cache was
#              enabled), and up to --limit runs since; prints a markdown table of the median
#              first-attempt duration per job, ready to paste into a PR or an issue
#
# Read-only. One API call per run (two lists and a commit lookup on top in --compare), and
# it checks the remaining quota first: keep --limit modest (5,000 calls/h per user).
# Output: TSV rows (run, created, event, branch, job, seconds, runner), then a summary;
# with --compare, the TSV of both sides on stderr and the markdown table on stdout.
set -euo pipefail

usage() { sed -n '2,20s/^# \{0,1\}//p' "$0" >&2; exit 2; }
die() { echo "job-durations: $*" >&2; exit 1; }

repo="" workflow=ci.yml job="" event="" branch="" limit=20 all=false compare=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --workflow) workflow=${2:-}; shift 2 ;;
    --job) job=${2:-}; shift 2 ;;
    --event) event=${2:-}; shift 2 ;;
    --branch) branch=${2:-}; shift 2 ;;
    --limit) limit=${2:-}; shift 2 ;;
    --all) all=true; shift ;;
    --compare) compare=${2:-}; shift 2 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) repo=$1; shift ;;
  esac
done
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ $limit =~ ^[1-9][0-9]*$ ]] || { echo "bad --limit" >&2; exit 2; }

# Calls this run needs, against what is left of the hour's quota (rate_limit itself is free).
need=$limit
if [[ -n $compare ]]; then need=$((2 * limit + 3)); fi
left=$(gh api rate_limit --jq .resources.core.remaining 2>/dev/null || echo "")
if [[ $left =~ ^[0-9]+$ ]] && ((left < need + 50)); then
  reset=$(gh api rate_limit --jq .resources.core.reset 2>/dev/null || echo "")
  die "needs ~$need API calls and only $left are left this hour${reset:+ (resets at epoch $reset)}: lower --limit or wait"
fi

# Prints TSV rows for the runs matching the filters (plus an optional --created query).
collect() { # [created query]
  local created=${1:-} runs args
  args=(-R "$repo" --workflow "$workflow" --limit "$limit" --json "databaseId,createdAt,event,headBranch,conclusion,status")
  if [[ -n $event ]]; then args+=(--event "$event"); fi
  if [[ -n $branch ]]; then args+=(--branch "$branch"); fi
  if [[ -n $created ]]; then args+=(--created "$created"); fi
  runs=$(gh run list "${args[@]}" --jq \
    ".[] | select(.status == \"completed\") | select($all or .conclusion == \"success\")
     | [.databaseId, .createdAt, .event, .headBranch] | @tsv")
  [[ -n $runs ]] || return 0
  while IFS=$'\t' read -r id created_at ev br; do
    # attempts/1: the first attempt only, even when the run was rerun later.
    if ! jobs=$(gh api "repos/$repo/actions/runs/$id/attempts/1/jobs?per_page=100" 2>/dev/null); then
      echo "run $id: could not read its jobs" >&2
      continue
    fi
    # Jobs with a runner only: API-created check runs show up as pseudo-jobs without one.
    jq -r --arg job "$job" --arg id "$id" --arg created "$created_at" --arg ev "$ev" --arg br "$br" '
      .jobs[] | select(.runner_name != null and .runner_name != "" and .started_at != null and .completed_at != null)
      | select($job == "" or .name == $job)
      | [$id, $created, $ev, $br, .name,
         ((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601)), .runner_name] | @tsv' \
      <<<"$jobs"
  done <<<"$runs"
}

# `job n median min max` per job, from TSV rows on stdin (seconds in column 6).
stats() {
  awk -F'\t' '
    { s[$5] = s[$5] " " $6 }
    END {
      for (j in s) {
        n = split(substr(s[j], 2), v, " ")
        # insertion sort: n is small
        for (i = 2; i <= n; i++) { x = v[i] + 0; k = i - 1; while (k > 0 && v[k] + 0 > x) { v[k + 1] = v[k]; k-- } v[k + 1] = x }
        med = (n % 2) ? v[(n + 1) / 2] : (v[n / 2] + v[n / 2 + 1]) / 2
        printf "%s\t%d\t%.0f\t%d\t%d\n", j, n, med, v[1], v[n]
      }
    }' | sort
}

header=$'run\tcreated\tevent\tbranch\tjob\tseconds\trunner'

if [[ -z $compare ]]; then
  rows=$(collect)
  [[ -n $rows ]] || die "no matching completed runs"
  printf '%s\n%s\n\n' "$header" "$rows"
  stats <<<"$rows" | while IFS=$'\t' read -r j n med lo hi; do
    printf '%s: n=%d median=%d s (%s min) min=%d max=%d%s\n' "$j" "$n" "$med" "$(awk -v s="$med" 'BEGIN { printf "%.1f", s / 60 }')" "$lo" "$hi" \
      "$( ((n < 5)) && echo "  <- fewer than 5 runs: no verdict yet")"
  done
  exit 0
fi

# --compare: a date, an ISO time, or a commit (resolved to its committer date).
if [[ $compare =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:]+(Z|[+-][0-9:]+)?)?$ ]]; then
  since=$compare
elif [[ $compare =~ ^[0-9a-f]{7,40}$ ]]; then
  since=$(gh api "repos/$repo/commits/$compare" --jq .commit.committer.date 2>/dev/null) ||
    die "could not resolve commit $compare in $repo"
  [[ -n $since ]] || die "commit $compare has no committer date"
else
  die "--compare takes a date (YYYY-MM-DD), an ISO 8601 time or a commit SHA"
fi

before=$(collect "<$since")
after=$(collect ">=$since")
{
  printf 'side\t%s\n' "$header"
  if [[ -n $before ]]; then awk '{ print "before\t" $0 }' <<<"$before"; fi
  if [[ -n $after ]]; then awk '{ print "after\t" $0 }' <<<"$after"; fi
} >&2
[[ -n $before || -n $after ]] || die "no matching completed runs on either side of $since"

join_stats() { # job lines of both sides: job n med lo hi
  local side
  for side in before after; do
    local rows=$before
    [[ $side == after ]] && rows=$after
    if [[ -n $rows ]]; then stats <<<"$rows" | sed "s/^/$side\t/"; fi
  done
}

filters="workflow \`$workflow\`${event:+, event \`$event\`}${branch:+, branch \`$branch\`}, $( $all && echo "all conclusions" || echo "successful runs") only, first attempts"
join_stats | awk -F'\t' -v since="$since" -v compare="$compare" -v filters="$filters" '
  function fmt(s) { return sprintf("%.1f min", s / 60) }
  {
    jobs[$2] = 1
    n[$1, $2] = $3; med[$1, $2] = $4; lo[$1, $2] = $5; hi[$1, $2] = $6
  }
  END {
    label = (compare == since) ? since : compare " (" since ")"
    printf "First-attempt job duration, median, before vs since %s (%s):\n\n", label, filters
    print "| Job | Before | After | Change |"
    print "| --- | ---: | ---: | ---: |"
    few = 0
    for (j in jobs) {
      b = (("before", j) in n) ? sprintf("%s (n=%d, %s–%s)", fmt(med["before", j]), n["before", j], fmt(lo["before", j]), fmt(hi["before", j])) : "no runs"
      a = (("after", j) in n) ? sprintf("%s (n=%d, %s–%s)", fmt(med["after", j]), n["after", j], fmt(lo["after", j]), fmt(hi["after", j])) : "no runs"
      c = "n/a"
      if ((("before", j) in n) && (("after", j) in n) && med["before", j] > 0)
        c = sprintf("%+.0f %%", 100 * (med["after", j] - med["before", j]) / med["before", j])
      if (n["before", j] + 0 < 5 || n["after", j] + 0 < 5) { c = c " *"; few = 1 }
      printf "| `%s` | %s | %s | %s |\n", j, b, a, c
    }
    if (few) print "\n\\* fewer than 5 runs on one side: no verdict yet."
  }'
