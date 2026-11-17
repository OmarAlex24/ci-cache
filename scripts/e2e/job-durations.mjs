#!/usr/bin/env node
// Tests scripts/job-durations.sh (and that the skill's copy is the same file) against a fake
// `gh` that serves canned runs and jobs: no GitHub API call, no quota spent. The fake applies
// --created and --jq the way gh does, and logs every call.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const SCRIPT = join(ROOT, "scripts", "job-durations.sh");
const work = mkdtempSync(join(tmpdir(), "ci-cache-durations-e2e-"));
const bin = join(work, "bin");
mkdirSync(bin);

// Before 2026-10-01: ci takes 700-760 s (median 740); since: 480-520 s (median 500).
// lint takes 60 s throughout. A failed run and a run still in progress are ignored.
const runs = [];
const jobs = {};
let id = 1000;
function addRun(createdAt, ciSeconds, conclusion = "success", status = "completed") {
  const runId = ++id;
  runs.push({ databaseId: runId, createdAt, event: "pull_request", headBranch: `b${runId}`, conclusion, status });
  const start = Date.parse(createdAt) + 30_000;
  const job = (name, seconds) => ({
    name,
    runner_name: "runner-1",
    started_at: new Date(start).toISOString().replace(/\.\d+Z$/, "Z"),
    completed_at: new Date(start + seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  });
  // A pseudo-job without a runner (an API-created check run) must not count.
  jobs[runId] = { jobs: [job("ci", ciSeconds), job("lint", 60), { name: "check", runner_name: null, started_at: null, completed_at: null }] };
}
for (const [day, s] of [["2026-09-20", 700], ["2026-09-22", 740], ["2026-09-24", 760], ["2026-09-26", 720], ["2026-09-28", 750]]) addRun(`${day}T10:00:00Z`, s);
for (const [day, s] of [["2026-10-02", 500], ["2026-10-04", 480], ["2026-10-06", 520], ["2026-10-08", 490], ["2026-10-10", 510]]) addRun(`${day}T10:00:00Z`, s);
addRun("2026-10-11T10:00:00Z", 9999, "failure");
addRun("2026-10-12T10:00:00Z", 9999, "", "in_progress");
runs.reverse(); // gh lists newest first
writeFileSync(join(work, "runs.json"), JSON.stringify(runs));
writeFileSync(join(work, "jobs.json"), JSON.stringify(jobs));

const FAKE = `#!/usr/bin/env bash
# Fake gh: logs argv; serves runs.json / jobs.json; applies --created and --jq like gh.
set -u
printf '%s\\n' "$*" >>"$FAKE_LOG"
jqexpr="" created="" limit=20
if [ "$1 $2" = "api rate_limit" ]; then
  echo '{"resources":{"core":{"limit":5000,"remaining":'"\${FAKE_REMAINING:-4999}"',"reset":1794929432,"used":1}}}' | jq -r "$4"; exit 0
fi
if [ "$1 $2" = "run list" ]; then
  while [ $# -gt 0 ]; do case $1 in --jq) jqexpr=$2; shift 2 ;; --created) created=$2; shift 2 ;; --limit) limit=$2; shift 2 ;; *) shift ;; esac; done
  op=\${created%%[0-9]*}; date=\${created#"$op"}
  jq --arg op "$op" --arg d "$date" --argjson n "$limit" '
    map(select($op == "" or ($op == "<" and .createdAt < $d) or ($op == ">=" and .createdAt >= $d))) | .[:$n]' "$FAKE_DIR/runs.json" | jq -r "$jqexpr"
  exit 0
fi
case $2 in
  repos/*/commits/*) [ "\${2##*/}" = abc1234 ] || { echo '{"message":"No commit found"}' >&2; exit 1; }
    echo '{"commit":{"committer":{"date":"2026-10-01T00:00:00Z"}}}' | jq -r "$4" ;;
  repos/*/actions/runs/*/attempts/1/jobs*) r=\${2#*/runs/}; r=\${r%%/*}; jq --arg r "$r" '.[$r]' "$FAKE_DIR/jobs.json" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 9 ;;
esac
`;
writeFileSync(join(bin, "gh"), FAKE);
chmodSync(join(bin, "gh"), 0o755);

async function durations(args, env = {}) {
  const log = join(work, "calls.log");
  writeFileSync(log, "");
  const r = await run("bash", [SCRIPT, ...args], { env: { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_DIR: work, ...env } });
  return { ...r, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

try {
  console.log("0. the skill keeps an identical copy");
  const copy = await run("cmp", [SCRIPT, join(ROOT, "skill", "ci-cache", "scripts", "job-durations.sh")]);
  check(copy.code === 0, "skill/ci-cache/scripts/job-durations.sh == scripts/job-durations.sh");

  console.log("1. default mode: TSV rows and a summary per job");
  let r = await durations(["acme/widgets", "--job", "ci"]);
  check(r.code === 0, `exits 0${r.code ? `: ${r.stderr}` : ""}`);
  const rows = r.stdout.split("\n").filter((l) => /^\d+\t/.test(l));
  check(rows.length === 10 && rows.every((l) => l.split("\t")[4] === "ci"), "10 successful runs, the ci job only (no failed, in-progress or runner-less ones)");
  check(r.stdout.includes("ci: n=10 median=610 s (10.2 min) min=480 max=760"), "median of 10: the middle pair 520 and 700 → 610 s");
  check(r.calls.filter((c) => c.startsWith("api repos/")).length === 10, "one jobs call per run");

  console.log("2. --compare <date>: a markdown table, before vs since");
  r = await durations(["acme/widgets", "--compare", "2026-10-01"]);
  check(r.code === 0, `exits 0${r.code ? `: ${r.stderr}` : ""}`);
  const table = r.stdout;
  check(table.startsWith("First-attempt job duration, median, before vs since 2026-10-01 (workflow `ci.yml`, successful runs only, first attempts):"), "a heading with the cut-off and the filters");
  check(table.includes("| Job | Before | After | Change |\n| --- | ---: | ---: | ---: |"), "a markdown table");
  check(table.includes("| `ci` | 12.3 min (n=5, 11.7 min–12.7 min) | 8.3 min (n=5, 8.0 min–8.7 min) | -32 % |"), "ci: 740 s → 500 s, -32 %");
  check(table.includes("| `lint` | 1.0 min (n=5, 1.0 min–1.0 min) | 1.0 min (n=5, 1.0 min–1.0 min) | +0 % |"), "lint: unchanged");
  check(!table.includes("fewer than 5"), "no small-sample warning with 5 runs per side");
  check(r.calls.includes("run list -R acme/widgets --workflow ci.yml --limit 20 --json databaseId,createdAt,event,headBranch,conclusion,status --created <2026-10-01 --jq " + r.calls.find((c) => c.includes("--created <"))?.split(" --jq ")[1]), "lists the runs before with --created <date");
  check(r.calls.some((c) => c.includes("--created >=2026-10-01")), "and the runs since with --created >=date");
  check(r.stderr.split("\n").filter((l) => /^(before|after)\t/.test(l)).length === 20, "the 20 TSV rows go to stderr, tagged before/after");

  console.log("3. --compare <commit>: its committer date is the cut-off");
  r = await durations(["acme/widgets", "--job", "ci", "--compare", "abc1234"]);
  check(r.code === 0 && r.stdout.includes("before vs since abc1234 (2026-10-01T00:00:00Z)") && r.stdout.includes("| `ci` | 12.3 min"), "resolves the commit and compares the same runs");
  check(!r.stdout.includes("`lint`"), "--job keeps one job");
  r = await durations(["acme/widgets", "--compare", "deadbee"]);
  check(r.code !== 0 && r.stderr.includes("could not resolve commit deadbee"), "an unknown commit fails clearly");
  r = await durations(["acme/widgets", "--compare", "last week"]);
  check(r.code !== 0 && r.stderr.includes("--compare takes a date"), "a value that is neither fails clearly");

  console.log("4. small samples and the quota");
  r = await durations(["acme/widgets", "--job", "ci", "--compare", "2026-10-01", "--limit", "3"]);
  check(r.code === 0 && r.stdout.includes("| -32 % *|") === false && /\| -?\d+ % \* \|/.test(r.stdout) && r.stdout.includes("fewer than 5 runs on one side"), "fewer than 5 runs per side: the change is starred");
  r = await durations(["acme/widgets", "--compare", "2026-10-01"], { FAKE_REMAINING: "40" });
  check(r.code !== 0 && r.stderr.includes("needs ~43 API calls and only 40 are left"), "refuses when the hour's quota can't cover it");
  check(!r.calls.some((c) => c.startsWith("run list")), "and makes no other call");

  console.log("e2e job-durations: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
