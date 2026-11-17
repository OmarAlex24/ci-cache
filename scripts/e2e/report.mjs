#!/usr/bin/env node
// Tests report/report.sh (the report action) with fixtures taken from real output
// (turbo 2.11.10 run summaries, sccache 0.19.0 --stats-format json) and with a real turbo
// run that writes its summaries through TURBO_RUN_SUMMARY=true, as the setup action sets it.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const REPORT = join(ROOT, "report", "report.sh");
const FIXTURES = join(ROOT, "scripts", "e2e", "fixtures");
const TURBO = join(ROOT, "node_modules", ".bin", "turbo");
const work = mkdtempSync(join(tmpdir(), "ci-cache-report-e2e-"));

/** A job: RUNNER_TEMP with the setup action's state, a workspace and a summary file. */
function job(name, { session, fingerprint } = {}) {
  const dir = join(work, name);
  for (const d of ["temp/ci-cache", "workspace", "bin"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "summary"), "");
  if (session) writeFileSync(join(dir, "temp/ci-cache/session"), `tier=${session.tier}\nbranch=${session.branch}\nworkdir=${join(dir, "workspace")}\n`);
  if (fingerprint) writeFileSync(join(dir, "temp/ci-cache/fingerprint-compare"), fingerprint);
  return dir;
}

/** A fake sccache that prints a fixture (or fails). */
function fakeSccache(dir, fixture) {
  const script = fixture
    ? `#!/bin/sh\n[ "$1" = --show-stats ] && cat '${join(FIXTURES, fixture)}'\n`
    : "#!/bin/sh\nexit 1\n";
  writeFileSync(join(dir, "bin", "sccache"), script);
  chmodSync(join(dir, "bin", "sccache"), 0o755);
}

/** Copies turbo run fixtures into workspace/.turbo/runs with an mtime relative to now. */
function turboRuns(dir, files, ageSeconds = -5) {
  const runs = join(dir, "workspace", ".turbo", "runs");
  mkdirSync(runs, { recursive: true });
  for (const file of files) {
    copyFileSync(join(FIXTURES, file), join(runs, file));
    const t = new Date(Date.now() - ageSeconds * 1000);
    utimesSync(join(runs, file), t, t);
  }
}

async function report(dir, { path, env = {} } = {}) {
  const r = await run("bash", [REPORT], {
    cwd: join(dir, "workspace"),
    env: {
      PATH: path ?? `${join(dir, "bin")}:${process.env.PATH}`,
      HOME: dir,
      RUNNER_TEMP: join(dir, "temp"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      GITHUB_WORKSPACE: join(dir, "workspace"),
      ...env,
    },
  });
  let summary = "";
  try {
    summary = readFileSync(join(dir, "summary"), "utf8");
  } catch {
    // a directory in the error case
  }
  return { ...r, summary, out: r.stdout + r.stderr };
}

/** PATH with only the tools report.sh needs (no jq): forces the python3 fallback. */
async function pathWithoutJq(dir) {
  const bin = join(dir, "bin");
  for (const tool of ["bash", "sed", "head", "find", "sort", "awk", "mktemp", "rm", "cat", "python3", "env"]) {
    const found = (await run("bash", ["-c", `command -v ${tool}`])).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  return bin;
}

try {
  console.log("1. fixtures: sccache with hits and misses, turbo runs from this job, a fingerprint mismatch");
  let dir = job("full", { session: { tier: "rama", branch: "feature/<b>|x" }, fingerprint: "status=mismatch\nkeys=2\n" });
  fakeSccache(dir, "sccache-stats.json");
  turboRuns(dir, ["turbo-run-2.json"], 3600); // from before the setup step: ignored
  turboRuns(dir, ["turbo-run-1.json", "turbo-run-3.json"]);
  let r = await report(dir);
  check(r.code === 0, "exits 0");
  check(r.summary.startsWith("### ci-cache\n"), "writes a ci-cache block to the job summary");
  check(r.summary.includes("| Session | `rama` (branch feature/&lt;b&gt;&#124;x) |"), "session tier and branch (escaped)");
  check(r.summary.includes("| sccache | 1 hits, 2 misses (33.3 % hit rate) |"), "sccache: 1 hit, 2 misses, 33.3 %");
  check(r.summary.includes("| Turbo | 2 of 4 tasks from cache, 0 of them remote (50.0 %); 2 run(s) |"), "turbo: only this job's runs (2 of 4 from cache)");
  check(r.summary.includes("**2 line(s) that enter the cache keys differ"), "fingerprint mismatch with the number of lines");
  check(!r.summary.includes("/tmp/sccache") && !r.out.includes("Local disk"), "never prints sccache's cache location");
  check(r.stdout.split("\n").every((l) => l === "" || l.startsWith("ci-cache report: ")), "every log line is prefixed (no workflow commands)");

  console.log("2. the same without jq (python3 fallback)");
  dir = job("no-jq", { session: { tier: "rama", branch: "feature/x" }, fingerprint: "status=match\nkeys=0\n" });
  fakeSccache(dir, "sccache-stats.json");
  turboRuns(dir, ["turbo-run-1.json", "turbo-run-3.json"]);
  r = await report(dir, { path: await pathWithoutJq(dir) });
  check(r.code === 0 && r.summary.includes("1 hits, 2 misses (33.3 % hit rate)") && r.summary.includes("2 of 4 tasks from cache"), "same numbers without jq");
  check(r.summary.includes("matches the sandbox's"), "fingerprint match");

  console.log("3. nothing to report");
  dir = job("empty");
  r = await report(dir, { path: "/usr/bin:/bin" });
  check(r.code === 0, "exits 0");
  check(r.summary.includes("no ci-cache session in this job") && r.summary.includes("sccache is not on PATH"), "says there is no session and no sccache");
  check(r.summary.includes("no turbo run summaries found") && r.summary.includes("--summarize"), "says how to get turbo summaries");
  check(r.summary.includes("not compared (fingerprint-compare off"), "fingerprint not compared");
  dir = job("idle", { session: { tier: "main", branch: "main" }, fingerprint: "status=skipped\nkeys=0\n" });
  fakeSccache(dir, "sccache-empty.json");
  r = await report(dir);
  check(r.summary.includes("no compilations went through sccache") && r.summary.includes("only on the branch tier"), "an idle sccache and a skipped comparison");

  console.log("4. failures never fail the step");
  dir = job("broken", { session: { tier: "rama", branch: "b" }, fingerprint: "status=error\n" });
  fakeSccache(dir, null);
  mkdirSync(join(dir, "workspace", ".turbo", "runs"), { recursive: true });
  writeFileSync(join(dir, "workspace", ".turbo", "runs", "bad.json"), "{not json");
  r = await report(dir);
  check(r.code === 0 && r.summary.includes("could not read sccache's stats"), "sccache failing → a row that says so, exit 0");
  check(r.summary.includes("could not read the turbo run summaries"), "broken turbo JSON → a row that says so");
  check(r.summary.includes("could not be compared"), "fingerprint error");
  r = await report(dir, { env: { GITHUB_STEP_SUMMARY: join(dir, "temp") } });
  check(r.code === 0, "an unwritable job summary still exits 0");

  console.log("5. a real turbo run with TURBO_RUN_SUMMARY=true (what the setup action exports)");
  dir = job("real-turbo", { session: { tier: "rama", branch: "feature/real" } });
  const ws = join(dir, "workspace");
  const files = {
    "package.json": JSON.stringify({ name: "root", private: true, packageManager: "npm@10.9.2", workspaces: ["packages/*"] }),
    "turbo.json": JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }),
    "packages/app/package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { build: "node build.js" } }),
    "packages/app/build.js": 'require("node:fs").mkdirSync("dist", { recursive: true });\n',
    ".gitignore": "node_modules\ndist\n.turbo\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(ws, path, ".."), { recursive: true });
    writeFileSync(join(ws, path), content);
  }
  await run("git", ["-C", ws, "init", "-q"]);
  await run("git", ["-C", ws, "add", "-A"]);
  await run("git", ["-C", ws, "-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "-m", "x"]);
  const turboEnv = { ...process.env, TURBO_RUN_SUMMARY: "true", TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1", DO_NOT_TRACK: "1" };
  await new Promise((resolve) => setTimeout(resolve, 1100)); // run summaries strictly newer than the state file
  for (let i = 0; i < 2; i++) {
    const t = await run(TURBO, ["run", "build"], { cwd: ws, env: turboEnv });
    check(t.code === 0, `turbo run build #${i + 1} succeeds`);
  }
  // A PATH without sccache: the host's real sccache server must not be touched.
  r = await report(dir, { path: await pathWithoutJq(dir) });
  check(r.code === 0 && r.summary.includes("| Turbo | 1 of 2 tasks from cache, 0 of them remote (50.0 %); 2 run(s) |"), "counts the real run summaries: 1 of 2 from cache");

  console.log("e2e report: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
