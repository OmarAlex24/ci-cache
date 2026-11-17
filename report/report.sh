#!/usr/bin/env bash
# Step of report/action.yml: writes a ci-cache table to the job summary
# ($GITHUB_STEP_SUMMARY) at the end of the job:
#   - the session's tier and branch (inputs, or what the setup action left in
#     $RUNNER_TEMP/ci-cache/session);
#   - sccache hits, misses and hit rate (`sccache --show-stats --stats-format json`), and an
#     estimate of the compile time the hits saved (see sccache_saved_ms);
#   - Turbo tasks from cache vs executed, and the task time they saved (Turbo's own
#     `timeSaved`), from the run summaries this job wrote (.turbo/runs/*.json; the setup
#     action exports TURBO_RUN_SUMMARY=true);
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

# `hits misses compilations compile_ms hit_read_ms` from sccache's JSON stats (counts summed
# over languages; the durations are sccache's totals, {secs, nanos}, in ms).
sccache_counts() { # <json file>
  if command -v jq >/dev/null 2>&1; then
    jq -r '.stats | def ms(d): ((d.secs // 0) * 1000 + (d.nanos // 0) / 1000000 | floor);
      [([.cache_hits.counts[]?] | add // 0), ([.cache_misses.counts[]?] | add // 0),
       (.compilations // 0), ms(.compiler_write_duration // {}), ms(.cache_read_hit_duration // {})] | @tsv' "$1"
  else
    python3 -c '
import json, sys
s = json.load(open(sys.argv[1]))["stats"]
ms = lambda d: int((d or {}).get("secs", 0) * 1000 + (d or {}).get("nanos", 0) / 1e6)
print(sum(s["cache_hits"]["counts"].values()), sum(s["cache_misses"]["counts"].values()),
      s.get("compilations", 0), ms(s.get("compiler_write_duration")), ms(s.get("cache_read_hit_duration")), sep="\t")' "$1"
  fi
}

# `cached attempted remote saved_ms` summed over turbo run summaries. saved_ms is the sum of
# each task's cache.timeSaved: Turbo's record of how long the cached task took when it ran.
turbo_counts() { # <json files...>
  if command -v jq >/dev/null 2>&1; then
    jq -rs '[(map(.execution.cached // 0) | add), (map(.execution.attempted // 0) | add),
      ([.[].tasks[]? | select(.cache.source == "REMOTE")] | length),
      ([.[].tasks[]?.cache.timeSaved // 0] | add // 0)] | @tsv' "$@"
  else
    python3 -c '
import json, sys
runs = [json.load(open(f)) for f in sys.argv[1:]]
cached = sum(r.get("execution", {}).get("cached", 0) for r in runs)
attempted = sum(r.get("execution", {}).get("attempted", 0) for r in runs)
tasks = [t for r in runs for t in r.get("tasks", [])]
remote = sum(1 for t in tasks if t.get("cache", {}).get("source") == "REMOTE")
saved = sum(t.get("cache", {}).get("timeSaved") or 0 for t in tasks)
print(cached, attempted, remote, saved, sep="\t")' "$@"
  fi
}

# Milliseconds as "850 ms", "12.3 s" or "4 min 05 s".
duration() { # <ms>
  awk -v ms="$1" 'BEGIN {
    if (ms < 1000) printf "%d ms", ms
    else if (ms < 60000) printf "%.1f s", ms / 1000
    else { s = int(ms / 1000 + 0.5); printf "%d min %02d s", int(s / 60), s % 60 } }'
}

# An ESTIMATE of the compile time sccache's hits saved: hits x (the job's average compile
# time - the average time to read a hit), both from sccache's own totals. It assumes a hit
# would have compiled as long as this job's average compilation, so it needs enough
# compilations to average (MIN_COMPILATIONS); it is compile time summed over crates, not
# wall-clock (cargo compiles in parallel). Prints nothing when it can't estimate.
MIN_COMPILATIONS=10
sccache_saved() { # <hits> <compilations> <compile_ms> <hit_read_ms>
  local hits=$1 compilations=$2 compile_ms=$3 read_ms=$4
  ((hits > 0 && compilations >= MIN_COMPILATIONS)) || return 0
  awk -v h="$hits" -v c="$compilations" -v cm="$compile_ms" -v rm="$read_ms" 'BEGIN {
    saved = h * (cm / c - rm / h); if (saved > 0) printf "%d", saved }'
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
    IFS=$'\t' read -r hits misses compilations compile_ms read_ms <<<"$counts"
    if ((hits + misses == 0)); then
      sccache_row="no compilations went through sccache"
    else
      sccache_row="$hits hits, $misses misses ($(percent "$hits" $((hits + misses))) hit rate)"
      saved=$(sccache_saved "$hits" "${compilations:-0}" "${compile_ms:-0}" "${read_ms:-0}")
      if [[ -n $saved ]]; then
        sccache_row+="; est. ~$(duration "$saved") of compile time saved (hits × this job's average compile time over $compilations compilations; summed over crates, not wall-clock)"
      elif ((hits > 0)); then
        sccache_row+="; no time-saved estimate (fewer than $MIN_COMPILATIONS compilations in this job to average)"
      fi
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
    IFS=$'\t' read -r cached attempted remote saved_ms <<<"$counts"
    turbo_row="$cached of $attempted tasks from cache, $remote of them remote ($(percent "$cached" "$attempted")); ${#runs[@]} run(s)"
    if ((${saved_ms:-0} > 0)); then turbo_row+="; $(duration "$saved_ms") of task time saved (Turbo's timeSaved, summed over tasks)"; fi
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
