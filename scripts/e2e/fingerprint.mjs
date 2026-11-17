#!/usr/bin/env node
// Sandbox vs CI fingerprint comparison, end to end against `wrangler dev`:
// ci-cache-env.sh (sandbox key) uploads the sandbox's cache fingerprint, then
// setup/fingerprint-compare.sh (the setup action's step, with a branch-tier CI session
// for the same branch) downloads it and compares it with its own.
// The CI session is signed with .dev.vars' SESSION_SECRET: real OIDC only exists in Actions.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, mintSession, ROOT, run, startWorker } from "./lib.mjs";

const ENV_SCRIPT = join(ROOT, "scripts", "ci-cache-env.sh");
const COMPARE = join(ROOT, "setup", "fingerprint-compare.sh");
const REPO = "acme/e2e-fingerprint";
const REPO_ID = 555000222;
const BRANCH = "feature/fingerprint-e2e";

const key = `sk_${randomBytes(24).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
const worker = await startWorker({
  vars: { SANDBOX_KEYS: JSON.stringify({ [hash]: { repoId: REPO_ID, repo: REPO, label: "e2e" } }) },
});
const work = mkdtempSync(join(tmpdir(), "ci-cache-fingerprint-e2e-"));
// Sandbox and CI share the checkout path and HOME, as with mount-workdir on a Boat runner.
const checkout = join(work, "repo");
const home = join(work, "home");
mkdirSync(checkout);
mkdirSync(home);
const base = { PATH: process.env.PATH, HOME: home, SCCACHE_SERVER_PORT: "4998", LANG: "C" };

/** The sandbox: ci-cache-env.sh with RUSTFLAGS; returns its output and the loaded exports. */
async function sandbox(rustflags) {
  const env = { ...base, CI_CACHE_URL: worker.url, CI_CACHE_SANDBOX_KEY: key, RUSTFLAGS: rustflags };
  const r = await run("bash", [ENV_SCRIPT, checkout], { env, cwd: checkout });
  const dump = await run("bash", ["-c", `set -a; source "${home}/.ci-cache.env"; env`], { env: { PATH: base.PATH } });
  const exports = Object.fromEntries(
    dump.stdout
      .split("\n")
      .filter((l) => /^(TURBO_|SCCACHE_|CARGO_|RUSTC_)/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { ...r, out: r.stdout + r.stderr, exports };
}

/** The setup action's compare step, with the environment the session step leaves behind. */
// `rustflags: undefined` leaves RUSTFLAGS unset (spawn drops undefined values). CI uses sccache
// (RUSTC_WRAPPER) unless `wrapper` is null, whatever the host has installed.
async function ci({ name, rustflags, exports, tier = "rama", branch = BRANCH, kind = "ci", wrapper = "sccache" }) {
  const dir = join(work, name);
  mkdirSync(dir);
  for (const f of ["summary", "output"]) writeFileSync(join(dir, f), "");
  const token = await mintSession({ repoId: REPO_ID, repo: REPO, tier, branch, kind });
  const env = {
    ...base,
    ...exports,
    TURBO_API: worker.url,
    TURBO_TOKEN: token,
    SCCACHE_WEBDAV_TOKEN: token,
    RUSTFLAGS: rustflags,
    RUSTC_WRAPPER: wrapper ?? undefined,
    INPUT_TIER: tier,
    INPUT_BRANCH: branch,
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
    GITHUB_OUTPUT: join(dir, "output"),
    RUNNER_TEMP: dir,
  };
  const r = await run("bash", [COMPARE], { env, cwd: checkout });
  const out = r.stdout + r.stderr;
  return {
    ...r,
    out,
    token,
    warnings: r.stdout.split("\n").filter((l) => l.startsWith("::warning")),
    summary: readFileSync(join(dir, "summary"), "utf8"),
    output: readFileSync(join(dir, "output"), "utf8"),
    state: (() => {
      try {
        return readFileSync(join(dir, "ci-cache", "fingerprint-compare"), "utf8");
      } catch {
        return "";
      }
    })(),
  };
}

try {
  const git = (...args) => run("git", ["-C", checkout, ...args]);
  await git("init", "-q", "-b", BRANCH);
  await git("-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "x");

  console.log("1. the sandbox uploads its fingerprint (RUSTFLAGS=-D warnings)");
  const sb = await sandbox("-D warnings");
  check(sb.code === 0, "ci-cache-env.sh exits cleanly");
  check(sb.out.includes("cache fingerprint uploaded"), "it says the fingerprint was uploaded");
  check(!sb.out.includes(key) && !sb.out.includes(sb.exports.TURBO_TOKEN), "doesn't print the key or the token");
  const ciToken = await mintSession({ repoId: REPO_ID, repo: REPO, tier: "rama", branch: BRANCH, kind: "ci" });
  const stored = await fetch(`${worker.url}/v1/fingerprint`, { headers: { authorization: `Bearer ${ciToken}` } });
  const text = await stored.text();
  check(stored.status === 200 && stored.headers.get("x-fingerprint-kind") === "sandbox", "the branch's CI can read it");
  check(text.includes("RUSTFLAGS=-D warnings") && text.includes(`checkout:     `), "it holds the sandbox's RUSTFLAGS and checkout");
  check(!text.includes(key) && !text.includes(sb.exports.TURBO_TOKEN), "it holds neither the sandbox key nor the session token");
  check(!/TURBO_TOKEN|SCCACHE_WEBDAV_TOKEN/.test(text), "no *_TOKEN variable at all");

  console.log("2. CI with another RUSTFLAGS");
  let r = await ci({ name: "mismatch", rustflags: "-C debuginfo=0", exports: sb.exports });
  check(r.code === 0, "the compare step exits 0");
  check(
    r.warnings.includes("::warning title=ci-cache cache key mismatch::RUSTFLAGS: sandbox=-D warnings ci=-C debuginfo=0"),
    "warns RUSTFLAGS: sandbox=-D warnings ci=-C debuginfo=0",
  );
  check(r.warnings.length === 1, `exactly one warning (got ${r.warnings.length}: vCPU, RAM, kernel... are not warnings)`);
  check(r.summary.includes("### ci-cache: sandbox vs CI fingerprint") && r.summary.includes("| RUSTFLAGS | -D warnings | -C debuginfo=0 |"), "adds a table to the job summary");
  check(r.output.includes("fingerprint-compare=mismatch") && r.state.includes("status=mismatch\nkeys=1"), "output fingerprint-compare=mismatch, state for the report");
  check(!r.out.includes(r.token) && !r.summary.includes(worker.url) && !r.out.includes(worker.url), "never prints the token or the Worker URL");

  console.log("3. CI with the same values");
  r = await ci({ name: "match", rustflags: "-D warnings", exports: sb.exports });
  check(r.code === 0 && r.warnings.length === 0, "no warnings");
  check(r.output.includes("fingerprint-compare=match") && r.summary.includes("match on every line"), "reports a match");

  console.log("4. no sandbox fingerprint for the branch");
  r = await ci({ name: "none", rustflags: "-D warnings", exports: sb.exports, branch: "feature/never-built" });
  check(r.code === 0 && r.warnings.length === 0 && r.summary === "", "silent: no warning and no summary");
  check(r.out.includes("no sandbox fingerprint for branch") && r.output.includes("fingerprint-compare=none"), "just a log line");

  console.log("5. hostile sandbox values are escaped");
  const sandboxToken = await mintSession({ repoId: REPO_ID, repo: REPO, tier: "rama", branch: "feature/hostile", kind: "sandbox" });
  const hostile = text.replace("RUSTFLAGS=-D warnings", "RUSTFLAGS=-D x%0A::error::pwned <img src=x>|`[a](b)`");
  const put = await fetch(`${worker.url}/v1/fingerprint`, { method: "PUT", body: hostile, headers: { authorization: `Bearer ${sandboxToken}` } });
  check(put.status === 204, "a sandbox fingerprint is stored with PUT");
  r = await ci({ name: "hostile", rustflags: "-D warnings", exports: sb.exports, branch: "feature/hostile" });
  check(r.warnings.length === 1 && r.warnings[0].includes("sandbox=-D x%250A::error::pwned"), "% is escaped in the workflow command");
  check(!r.stdout.split("\n").some((l) => l.startsWith("::error")), "no injected workflow command");
  check(r.summary.includes("&lt;img src=x&gt;&#124;&#96;&#91;a&#93;(b)&#96;") && !r.summary.includes("<img"), "markdown/HTML is escaped in the summary");

  console.log("6. main and main-ro");
  r = await ci({ name: "main", rustflags: "-D warnings", exports: sb.exports, tier: "main", branch: "main" });
  check(r.code === 0 && r.out.includes("CI fingerprint uploaded") && r.output.includes("fingerprint-compare=skipped"), "main uploads its fingerprint and skips the comparison");
  const sbSession = await mintSession({ repoId: REPO_ID, repo: REPO, tier: "rama", branch: "feature/new", kind: "sandbox" });
  const fromMain = await fetch(`${worker.url}/v1/fingerprint`, { headers: { authorization: `Bearer ${sbSession}` } });
  check(fromMain.status === 200 && fromMain.headers.get("x-fingerprint-source") === "main", "a sandbox on a new branch reads main's CI fingerprint");
  r = await ci({ name: "main-ro", rustflags: "-D warnings", exports: sb.exports, tier: "main-ro", branch: "main" });
  check(r.code === 0 && !r.out.includes("CI fingerprint uploaded") && r.output.includes("fingerprint-compare=skipped"), "main-ro doesn't upload");

  console.log("7. a failed upload never breaks the sandbox");
  const broken = await run("bash", [ENV_SCRIPT, checkout], {
    env: { ...base, CI_CACHE_URL: worker.url, CI_CACHE_SANDBOX_KEY: key, CI_CACHE_FINGERPRINT_SCRIPT: join(work, "missing.sh") },
    cwd: checkout,
  });
  check(broken.code === 0 && broken.stderr.includes("warning") && broken.stderr.includes("not uploaded"), "a missing cache-fingerprint.sh is a warning, exit 0");
  const off = await run("bash", [ENV_SCRIPT, checkout], {
    env: { ...base, CI_CACHE_URL: worker.url, CI_CACHE_SANDBOX_KEY: key, CI_CACHE_FINGERPRINT: "false" },
    cwd: checkout,
  });
  check(off.code === 0 && !/fingerprint (uploaded|not uploaded)/.test(off.stdout + off.stderr), "CI_CACHE_FINGERPRINT=false skips it");

  console.log("8. RUSTFLAGS set on one side only");
  r = await ci({ name: "ci-unset", rustflags: undefined, exports: sb.exports });
  check(
    r.warnings.length === 1 && r.warnings[0] === "::warning title=ci-cache cache key mismatch::RUSTFLAGS: sandbox=-D warnings ci=(missing)",
    `one warning, sandbox=-D warnings ci=(missing) (got ${JSON.stringify(r.warnings)})`,
  );
  let sb2 = await sandbox(undefined);
  check(sb2.out.includes("cache fingerprint uploaded"), "a sandbox without RUSTFLAGS uploads its fingerprint");
  r = await ci({ name: "sandbox-unset", rustflags: "-D warnings", exports: sb2.exports });
  check(
    r.warnings.length === 1 && r.warnings[0] === "::warning title=ci-cache cache key mismatch::RUSTFLAGS: sandbox=(missing) ci=-D warnings",
    `one warning, sides not swapped: sandbox=(missing) ci=-D warnings (got ${JSON.stringify(r.warnings)})`,
  );
  check(r.summary.includes("| RUSTFLAGS | (missing) | -D warnings |") && !r.summary.includes("(empty)"), "one summary row, with the right sides");
  r = await ci({ name: "unset-vs-empty", rustflags: "", exports: sb2.exports });
  check(r.warnings.length === 0 && r.output.includes("fingerprint-compare=match"), "unset and empty RUSTFLAGS are the same: no warning");

  console.log("9. CI without sccache (no RUSTC_WRAPPER, none of the sandbox's CARGO_/RUSTC_ exports)");
  sb2 = await sandbox("-D warnings");
  const turboOnly = Object.fromEntries(Object.entries(sb2.exports).filter(([k]) => !/^(CARGO_|RUSTC_)/.test(k)));
  r = await ci({ name: "no-sccache", rustflags: "-C debuginfo=0", exports: turboOnly, wrapper: null });
  check(r.code === 0 && r.warnings.length === 0, `no warnings (got ${JSON.stringify(r.warnings)})`);
  check(r.out.includes("RUSTC_WRAPPER is not set in this job"), "says why in the log");
  check(
    r.summary.includes("sccache is off in this job") && r.summary.includes("<details>") && r.summary.includes("| CARGO_INCREMENTAL | 0 | (missing) |"),
    "lists the sccache key differences under other differences",
  );
  check(r.output.includes("fingerprint-compare=match"), "the status is match (no warning raised)");

  console.log("e2e fingerprint: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.VERBOSE) console.error(worker.log());
  process.exitCode = 1;
} finally {
  await worker.stop();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
