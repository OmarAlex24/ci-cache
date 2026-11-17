#!/usr/bin/env bash
# Step of setup/action.yml that runs after the session step, in the workdir (so after
# mount-workdir: the checkout path is the real one) and with the exports of the session
# step already in the environment (TURBO_API, TURBO_TOKEN, RUSTC_WRAPPER, ...).
#
# 1. Generates this job's cache fingerprint (scripts/cache-fingerprint.sh) and uploads it
#    (PUT /v1/fingerprint; not on main-ro), so sandboxes can compare against CI.
# 2. On the branch tier, downloads the sandbox fingerprint of the same branch and compares
#    both with scripts/fingerprint-diff.sh. Each line that enters the cache keys (class KEY)
#    and differs becomes a `::warning` with the exact cause, plus a block in the job summary.
#    Lines that don't change keys (vCPU, RAM, kernel...) are not warnings.
#
# Inputs (env): INPUT_TIER, INPUT_BRANCH (session step outputs), TURBO_API, TURBO_TOKEN.
# It never fails the job: every problem is a log line and exit 0. It never prints the
# token, and the sandbox's values only reach the log escaped, inside a ::warning.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
scripts=${CI_CACHE_SCRIPTS:-$here/../scripts}
url=${TURBO_API:-}
token=${TURBO_TOKEN:-}
tier=${INPUT_TIER:-}
branch=${INPUT_BRANCH:-}
state=${RUNNER_TEMP:+$RUNNER_TEMP/ci-cache}

log() { echo "ci-cache: $*"; }

# Result for the job (step output `fingerprint-compare`) and for the report action.
finish() { # <status> [KEY differences]
  local status=$1 keys=${2:-0}
  if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "fingerprint-compare=$status" >>"$GITHUB_OUTPUT"; fi
  if [[ -n $state ]]; then
    mkdir -p "$state" && printf 'status=%s\nkeys=%s\n' "$status" "$keys" >"$state/fingerprint-compare"
  fi
  exit 0
}

# Workflow-command data: %, CR and LF must be escaped or the sandbox could inject commands.
command_data() {
  local s=$1
  s=${s//'%'/'%25'}
  s=${s//$'\r'/'%0D'}
  s=${s//$'\n'/'%0A'}
  printf '%s' "$s"
}

# A markdown table cell from untrusted text: no HTML, no pipes, no code spans or links.
md_cell() {
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

if [[ -z $url || -z $token ]]; then
  log "no ci-cache session in this job: fingerprint not compared"
  finish skipped
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
bash "$scripts/cache-fingerprint.sh" >"$work/ci.txt" 2>/dev/null
if [[ ! -s $work/ci.txt ]]; then
  log "cache-fingerprint.sh printed nothing: fingerprint not compared"
  finish error
fi

# The token goes through stdin (-H @-) so it never shows up in the process list.
api() { # <method> <output file> [curl args...]
  local method=$1 out=$2 code
  shift 2
  # curl's errors stay out of the log: they name the Worker's host.
  code=$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS --retry 2 -X "$method" -H @- -o "$out" -w '%{http_code}' "$@" "$url/v1/fingerprint" 2>/dev/null) || true
  printf '%s' "${code:-000}"
}

if [[ $tier != main-ro ]]; then
  code=$(api PUT /dev/null -H 'content-type: text/plain; charset=utf-8' --data-binary "@$work/ci.txt")
  if [[ $code == 204 ]]; then log "CI fingerprint uploaded"; else log "uploading the CI fingerprint answered $code"; fi
fi

if [[ $tier != rama ]]; then
  log "tier ${tier:-unknown}: there is no sandbox fingerprint to compare with"
  finish skipped
fi

code=$(api GET "$work/sandbox.txt")
case $code in
  200) ;;
  404)
    log "no sandbox fingerprint for branch '$branch' yet: nothing to compare"
    finish none
    ;;
  *)
    log "downloading the sandbox fingerprint answered $code: not compared"
    finish error
    ;;
esac

diff=$(FP_FORMAT=tsv bash "$scripts/fingerprint-diff.sh" "$work/sandbox.txt" "$work/ci.txt" 2>/dev/null)
rc=$?
if ((rc > 1)); then
  log "could not compare the fingerprints"
  finish error
fi

keys=0
key_rows="" other_rows=""
seen=$'\n'
while IFS=$'\t' read -r class item sandbox ci; do
  [[ -n ${class:-} ]] || continue
  label=${item#*|}
  # RUSTFLAGS (and a few more) appear in their section and among the variables: report once.
  entry="$label"$'\t'"$sandbox"$'\t'"$ci"
  [[ $seen != *$'\n'"$entry"$'\n'* ]] || continue
  seen+="$entry"$'\n'
  row="| $(md_cell "$label") | $(md_cell "$sandbox") | $(md_cell "$ci") |"$'\n'
  if [[ $class == KEY ]]; then
    keys=$((keys + 1))
    echo "::warning title=ci-cache cache key mismatch::$(command_data "$label: sandbox=${sandbox:0:200} ci=${ci:0:200}")"
    key_rows+=$row
  elif [[ $class == check ]]; then
    other_rows+=$row
  fi
done <<<"$diff"

if ((keys > 0)); then
  log "$keys line(s) that enter the cache keys differ from the sandbox's: see the warnings"
else
  log "the sandbox and CI fingerprints match on every line that enters the cache keys"
fi

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    echo "### ci-cache: sandbox vs CI fingerprint"
    echo
    if ((keys > 0)); then
      echo "**$keys line(s) that enter the cache keys differ.** CI can't reuse what the sandbox compiled on this branch until they match."
      echo
      echo "| Item | Sandbox | CI |"
      echo "| --- | --- | --- |"
      printf '%s' "$key_rows"
    else
      echo "The fingerprints match on every line that enters the cache keys."
    fi
    if [[ -n $other_rows ]]; then
      echo
      echo "<details><summary>Other differences (they don't change sccache keys, but may change another tool's cache)</summary>"
      echo
      echo "| Item | Sandbox | CI |"
      echo "| --- | --- | --- |"
      printf '%s' "$other_rows"
      echo
      echo "</details>"
    fi
    echo
  } >>"$GITHUB_STEP_SUMMARY"
fi

if ((keys > 0)); then finish mismatch "$keys"; fi
finish match
