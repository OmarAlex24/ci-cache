#!/usr/bin/env bash
# Classifies the Boat machine a run got, from boated-ci's machine-sampler.sh output
# (machine-samples.txt, uploaded as the machine-samples-<attempt> artifact):
# whole-run iowait % and steal %, and a class: `fast` (iowait < 5 %) or `slow-io`.
# Boat machines came in two classes (iowait ~2 % vs 15-23 %) that dominated run-to-run
# variance: compare durations only within one class.
#
#   machine-class.sh <machine-samples.txt> [...]
#   gh run download <run-id> -R O/R -n machine-samples-1 -D /tmp/s && machine-class.sh /tmp/s/machine-samples.txt
#
# Sample line: <epoch> <MemTotal> <MemAvailable> cpu user nice system idle iowait irq softirq steal ...
set -euo pipefail
[[ $# -ge 1 ]] || { sed -n '2,11s/^# \{0,1\}//p' "$0" >&2; exit 2; }
printf 'file\tseconds\tiowait\tsteal\tclass\n'
for f in "$@"; do
  awk -v file="$f" '
    $4 != "cpu" { next }
    {
      total = 0; for (i = 5; i <= 12; i++) total += $i
      if (!n++) { t0 = $1; tot0 = total; io0 = $9; st0 = $12 }
      t1 = $1; tot1 = total; io1 = $9; st1 = $12
    }
    END {
      if (n < 2 || tot1 == tot0) { printf "%s\t-\t-\t-\tno-samples\n", file; exit }
      io = (io1 - io0) * 100 / (tot1 - tot0); st = (st1 - st0) * 100 / (tot1 - tot0)
      class = io < 5 ? "fast" : "slow-io"
      if (st > 8) class = class "+steal"
      printf "%s\t%d\t%.1f %%\t%.1f %%\t%s\n", file, t1 - t0, io, st, class
    }' "$f"
done
