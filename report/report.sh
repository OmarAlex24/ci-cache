#!/usr/bin/env bash
# Step of report/action.yml: writes a ci-cache table to the job summary
# ($GITHUB_STEP_SUMMARY) at the end of the job:
#   - the session's tier and branch (inputs, or what the setup action left in
#     $RUNNER_TEMP/ci-cache/session);
#   - sccache hits, misses and hit rate (`sccache --show-stats --stats-format json`);
#   - Turbo tasks from cache vs executed, from the run summaries this job wrote
#     (.turbo/runs/*.json; the setup action exports TURBO_RUN_SUMMARY=true);
#   - the sandbox vs CI fingerprint comparison (setup/fingerprint-compare.sh).
#
# It never fails the job: every problem becomes a row that says so, and it always exits 0.
# It never prints sccache's cache location (with WebDAV it is the Worker's URL).
set -uo pipefail
trap 'exit 0' EXIT

state=${RUNNER_TEMP:+$RUNNER_TEMP/ci-cache}

# Value of `name=` in a key=value state file.
state_value() { # <file> <name>
  [[ -r $1 ]] || return 0
  sed -n "s/^$2=//p" "$1" | head -1
}

# A markdown cell from text we don't control (the branch is the PR author's choice).
md() {
  local s=${1:0:200}
  s=${s//'&'/'&amp;'}
  s=${s//'<'/'&lt;'}
  s=${s//'>'/'&gt;'}
  s=${s//'|'/'&#124;'}
  s=${s//'`'/'&#96;'}
  s=${s//'['/'&#91;'}
  s=${s//']'/'&#93;'}
  printf '%s' "$s"
}

# `hits misses` from sccache's JSON stats (sum over languages).
sccache_counts() { # <json file>
  if command -v jq >/dev/null 2>&1; then
    jq -r '.stats | [([.cache_hits.counts[]?] | add // 0), ([.cache_misses.counts[]?] | add // 0)] | @tsv' "$1"
  else
    python3 -c '
import json, sys
s = json.load(open(sys.argv[1]))["stats"]
print(sum(s["cache_hits"]["counts"].values()), sum(s["cache_misses"]["counts"].values()), sep="\t")' "$1"
  fi
}

# `cached attempted remote` summed over turbo run summaries.
turbo_counts() { # <json files...>
  if command -v jq >/dev/null 2>&1; then
    jq -rs '[(map(.execution.cached // 0) | add), (map(.execution.attempted // 0) | add),
      ([.[].tasks[]? | select(.cache.source == "REMOTE")] | length)] | @tsv' "$@"
  else
    python3 -c '
import json, sys
runs = [json.load(open(f)) for f in sys.argv[1:]]
cached = sum(r.get("execution", {}).get("cached", 0) for r in runs)
attempted = sum(r.get("execution", {}).get("attempted", 0) for r in runs)
remote = sum(1 for r in runs for t in r.get("tasks", []) if t.get("cache", {}).get("source") == "REMOTE")
print(cached, attempted, remote, sep="\t")' "$@"
  fi
}

percent() { # <part> <total>
  awk -v p="$1" -v t="$2" 'BEGIN { if (t > 0) printf "%.1f %%", 100 * p / t; else printf "n/a" }'
}

# --- session -------------------------------------------------------------------------
tier=${INPUT_TIER:-$(state_value "$state/session" tier)}
branch=${INPUT_BRANCH:-$(state_value "$state/session" branch)}
workdir=${INPUT_WORKING_DIRECTORY:-$(state_value "$state/session" workdir)}
workdir=${workdir:-${GITHUB_WORKSPACE:-$PWD}}
if [[ -n $tier ]]; then
  session_row="\`$(md "$tier")\` (branch $(md "${branch:-?}"))"
else
  session_row="no ci-cache session in this job (did the setup step run?)"
fi

# --- sccache ---------------------------------------------------------------------------
sccache_row="sccache is not on PATH"
if command -v sccache >/dev/null 2>&1; then
  tmp=$(mktemp)
  if sccache --show-stats --stats-format json >"$tmp" 2>/dev/null && counts=$(sccache_counts "$tmp" 2>/dev/null) && [[ -n $counts ]]; then
    IFS=$'\t' read -r hits misses <<<"$counts"
    if ((hits + misses == 0)); then
      sccache_row="no compilations went through sccache"
    else
      sccache_row="$hits hits, $misses misses ($(percent "$hits" $((hits + misses))) hit rate)"
    fi
  else
    sccache_row="could not read sccache's stats (is the server still running? set SCCACHE_IDLE_TIMEOUT=0)"
  fi
  rm -f "$tmp"
fi

# --- turbo -----------------------------------------------------------------------------
# Only the summaries written during this job: newer than the setup action's state file.
turbo_row="no turbo run summaries found (the setup action exports TURBO_RUN_SUMMARY=true; with an older pin, add --summarize to turbo run)"
runs=()
newer=()
if [[ -f $state/session ]]; then newer=(-newer "$state/session"); fi
while IFS= read -r file; do runs+=("$file"); done < <(
  find "$workdir" -maxdepth 4 -path '*/.turbo/runs/*.json' -not -path '*/node_modules/*' ${newer[@]+"${newer[@]}"} 2>/dev/null | sort
)
if ((${#runs[@]} > 0)); then
  if counts=$(turbo_counts "${runs[@]}" 2>/dev/null) && [[ -n $counts ]]; then
    IFS=$'\t' read -r cached attempted remote <<<"$counts"
    turbo_row="$cached of $attempted tasks from cache, $remote of them remote ($(percent "$cached" "$attempted")); ${#runs[@]} run(s)"
  else
    turbo_row="could not read the turbo run summaries"
  fi
fi

# --- fingerprint -----------------------------------------------------------------------
status=$(state_value "$state/fingerprint-compare" status)
keys=$(state_value "$state/fingerprint-compare" keys)
case $status in
  match) fingerprint_row="matches the sandbox's on every line that enters the cache keys" ;;
  mismatch) fingerprint_row="**${keys:-?} line(s) that enter the cache keys differ from the sandbox's**: see the warnings and the table above" ;;
  none) fingerprint_row="no sandbox fingerprint for this branch" ;;
  skipped) fingerprint_row="not compared (only on the branch tier)" ;;
  error) fingerprint_row="could not be compared (see the setup step's log)" ;;
  *) fingerprint_row="not compared (fingerprint-compare off, or an older setup action)" ;;
esac

table=$(
  echo "### ci-cache"
  echo
  echo "| | |"
  echo "| --- | --- |"
  echo "| Session | $session_row |"
  echo "| sccache | $sccache_row |"
  echo "| Turbo | $turbo_row |"
  echo "| Fingerprint vs sandbox | $fingerprint_row |"
  echo
)
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  printf '%s\n' "$table" >>"$GITHUB_STEP_SUMMARY" || echo "ci-cache: could not write the job summary"
fi
# Also in the log, with a prefix so no line can be read as a workflow command.
printf '%s\n' "$table" | sed 's/^/ci-cache report: /'
