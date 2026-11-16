#!/usr/bin/env bash
# Compares two ci-cache fingerprints (the output of the engine's scripts/cache-fingerprint.sh)
# and says which differences break cache keys.
#
#   fingerprint-diff.sh <sandbox> <ci>
#
# Each argument is either a raw fingerprint (what cache-fingerprint.sh prints) or a whole
# job log from `gh run view <id> --log` (the block printed by the setup action is extracted;
# FP_JOB=<job name> picks the job when the log has several).
#
# Classes:  KEY    breaks sccache keys (path, HOME, rustc, toolchain, RUSTFLAGS, CARGO_*...)
#           check  may change another stack's cache (node, turbo, go, docker, os...)
#           info   harmless (vCPU, RAM, kernel, SCCACHE_*/TURBO_* plumbing)
# Lines whose name looks like a secret are never printed; sk_/rk_ values are redacted.
# Exit: 0 no KEY differences, 1 at least one, 2 usage or input error.
set -euo pipefail

[[ $# -eq 2 ]] || { sed -n '2,15s/^# \{0,1\}//p' "$0" >&2; exit 2; }
for f in "$1" "$2"; do [[ -r $f ]] || { echo "cannot read $f" >&2; exit 2; }; done

# Raw fingerprint lines from a fingerprint file or a `gh run view --log` file.
extract() {
  local file=$1
  # The block starts at `== machine` (`== máquina` from actions pinned before the English output).
  if grep -qE $'\t.*== (machine|m.quina)' "$file"; then
    awk -F'\t' -v want="${FP_JOB:-}" '
      !found && index($0, "== m") && $0 ~ /== (machine|m.+quina)/ && (want == "" || $1 == want) { found = 1; step = $1 FS $2 }
      found {
        if (($1 FS $2) != step || index($0, "##[")) exit
        line = $0
        sub(/^[^\t]*\t[^\t]*\t/, "", line)
        print line
      }' "$file" |
      LC_ALL=C sed -E $'s/^\xEF\xBB\xBF//; s/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//'
  else
    cat "$file"
  fi
}

# "section|label<TAB>value", one per line, secrets dropped.
normalize() {
  awk '
    # Old fingerprints (Spanish output) use `máquina` and `usuario`: map them to the English names.
    /^== / { section = substr($0, 4); if (section ~ /^m.+quina$/) section = "machine"; vars = (section ~ /^variables/); next }
    {
      if (vars) { i = index($0, "="); if (!i) next; label = substr($0, 1, i - 1); value = substr($0, i + 1) }
      else { i = index($0, ":"); if (!i) next; label = substr($0, 1, i - 1); value = substr($0, i + 1) }
      if (label == "usuario") label = "user"
      sub(/^[ \t]+/, "", value); sub(/[ \t]+$/, "", value)
      if (tolower(label) ~ /token|key|secret|passw/) next
      if (value ~ /^npm (error|ERR)/ || value == "(no instalado)") value = "(not installed)"
      if (value == "(sin rust-toolchain.toml)") value = "(no rust-toolchain.toml)"
      gsub(/(sk|rk)_[A-Za-z0-9_-]+/, "<redacted>", value)
      print (vars ? "env" : section) "|" label "\t" value
    }'
}

class() {
  local key=$1
  case $key in
    *"|checkout" | *"|HOME" | rust\|* | env\|CARGO_* | env\|RUSTFLAGS | env\|RUSTDOCFLAGS | env\|RUSTC* | \
      env\|CC | env\|CXX | env\|CFLAGS | env\|CXXFLAGS | env\|LDFLAGS)
      echo KEY ;;
    *"|vCPU / RAM" | *"|kernel" | env\|SCCACHE_* | env\|TURBO_* | *"|pnpm store" | *"|GOCACHE")
      echo info ;;
    *) echo check ;;
  esac
}

a=$(mktemp) b=$(mktemp)
trap 'rm -f "$a" "$b"' EXIT
extract "$1" | normalize | sort -u >"$a"
extract "$2" | normalize | sort -u >"$b"
[[ -s $a ]] || { echo "no fingerprint found in $1" >&2; exit 2; }
[[ -s $b ]] || { echo "no fingerprint found in $2" >&2; exit 2; }

keys=0 checks=0 infos=0
out=$(
  cut -f1 "$a" "$b" | sort -u | while IFS= read -r k; do
    va=$(awk -F'\t' -v k="$k" '$1 == k { print $2; exit }' "$a")
    vb=$(awk -F'\t' -v k="$k" '$1 == k { print $2; exit }' "$b")
    grep -q -F -x "$k"$'\t'"$va" "$a" || va="(missing)"
    grep -q -F -x "$k"$'\t'"$vb" "$b" || vb="(missing)"
    [[ $va == "$vb" ]] && continue
    printf '%s\t%s\t%s\t%s\n' "$(class "$k")" "$k" "$va" "$vb"
  done
)

if [[ -z $out ]]; then
  echo "fingerprints match: nothing in them should make the cache miss"
  exit 0
fi
printf '%-5s  %-34s  %-30s  %s\n' class item "${FP_LEFT:-sandbox}" "${FP_RIGHT:-ci}"
while IFS=$'\t' read -r c k va vb; do
  printf '%-5s  %-34s  %-30s  %s\n' "$c" "${k/|//}" "${va:0:60}" "${vb:0:60}"
  case $c in KEY) keys=$((keys + 1)) ;; check) checks=$((checks + 1)) ;; *) infos=$((infos + 1)) ;; esac
done < <(printf '%s\n' "$out" | sort -t$'\t' -k1,1 -k2,2)
echo
echo "$keys KEY, $checks check, $infos info difference(s)"
if ((keys > 0)); then
  echo "Each KEY line makes sccache miss: align the sandbox with CI (references/rust.md)."
  exit 1
fi
