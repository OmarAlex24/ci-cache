#!/usr/bin/env node
// Tests scripts/ci-cache-env.sh against `wrangler dev` with a test sandbox key
// (generated here and passed to the Worker with --var SANDBOX_KEYS).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run, startWorker } from "./lib.mjs";

const SCRIPT = join(ROOT, "scripts", "ci-cache-env.sh");
const REPO = "acme/e2e-sandbox";
const REPO_ID = 555000111;

const key = `sk_${randomBytes(24).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
const worker = await startWorker({
  vars: { SANDBOX_KEYS: JSON.stringify({ [hash]: { repoId: REPO_ID, repo: REPO, label: "e2e" } }) },
});
const work = mkdtempSync(join(tmpdir(), "ci-cache-sandbox-e2e-"));

const claims = (token) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());

/** Runs the script as the sandbox would and loads the exports file in a clean bash. */
async function sandboxEnv({ dir, home, extraEnv = {}, path = process.env.PATH }) {
  const env = {
    PATH: path,
    HOME: home,
    CI_CACHE_URL: worker.url,
    CI_CACHE_SANDBOX_KEY: key,
    SCCACHE_SERVER_PORT: "4999",
    ...extraEnv,
  };
  const result = await run("bash", [SCRIPT, dir], { env });
  const file = extraEnv.CI_CACHE_ENV_FILE ?? join(home, ".ci-cache.env");
  let loaded = {};
  if (result.code === 0) {
    const dump = await run("bash", ["-c", `set -a; source "${file}"; env`], { env: { PATH: path } });
    loaded = Object.fromEntries(
      dump.stdout
        .split("\n")
        .filter((line) => /^(TURBO_|SCCACHE_|CARGO_|RUSTC_)/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  }
  return { ...result, file, loaded, output: result.stdout + result.stderr };
}

try {
  const repoDir = join(work, "repo");
  mkdirSync(repoDir);
  const git = (...args) => run("git", ["-C", repoDir, ...args]);
  await git("init", "-q", "-b", "feature/sandbox-e2e");
  await git("-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "x");
  const home = join(work, "home");
  mkdirSync(home);

  console.log("1. branch feature/sandbox-e2e");
  let r = await sandboxEnv({ dir: repoDir, home });
  check(r.code === 0, `the script exits cleanly (${r.output.trim().split("\n").at(-2) ?? ""})`);
  check(!r.output.includes(key) && !r.output.includes(r.loaded.TURBO_TOKEN ?? "###"), "doesn't print the key or the token");
  check((statSync(r.file).mode & 0o777) === 0o600, "~/.ci-cache.env ends up with mode 600");
  check(r.loaded.TURBO_API === worker.url && r.loaded.TURBO_TEAM === "e2e-sandbox", "exports TURBO_API and TURBO_TEAM (repo name)");
  check(r.loaded.SCCACHE_WEBDAV_ENDPOINT === `${worker.url}/dav` && r.loaded.SCCACHE_WEBDAV_TOKEN === r.loaded.TURBO_TOKEN, "exports SCCACHE_WEBDAV_*");
  check(r.loaded.CARGO_INCREMENTAL === "0", "exports CARGO_INCREMENTAL=0");
  check(r.loaded.SCCACHE_WEBDAV_DISABLE_CREATE_DIR === "true", "exports SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true");
  check(r.loaded.RUSTC_WRAPPER === "sccache", "exports RUSTC_WRAPPER=sccache (sccache is installed)");
  check(
    JSON.stringify(claims(r.loaded.TURBO_TOKEN)).includes('"tier":"rama","branch":"feature/sandbox-e2e","kind":"sandbox"'),
    "the token is rama (branch) tier for feature/sandbox-e2e, kind sandbox",
  );
  const status = await fetch(`${worker.url}/v8/artifacts/status`, { headers: { authorization: `Bearer ${r.loaded.TURBO_TOKEN}` } });
  check(status.status === 200, "the token works against /v8/artifacts/status");
  const put = await fetch(`${worker.url}/dav/0/1/2/abc`, {
    method: "PUT",
    body: "x",
    headers: { authorization: `Bearer ${r.loaded.SCCACHE_WEBDAV_TOKEN}` },
  });
  check(put.status === 201, "and against /dav (PUT)");

  console.log("2. branch named main");
  await git("checkout", "-q", "-b", "main");
  r = await sandboxEnv({ dir: repoDir, home });
  check(r.code === 0 && claims(r.loaded.TURBO_TOKEN).tier === "rama" && claims(r.loaded.TURBO_TOKEN).branch === "main", "still the rama tier");

  console.log("3. detached HEAD");
  await git("checkout", "-q", "--detach");
  r = await sandboxEnv({ dir: repoDir, home });
  check(r.code !== 0 && r.output.includes("CI_CACHE_BRANCH"), "fails and suggests CI_CACHE_BRANCH");
  r = await sandboxEnv({ dir: repoDir, home, extraEnv: { CI_CACHE_BRANCH: 'branch "odd"' } });
  check(r.code !== 0 && r.output.includes("400"), "an invalid branch (with a space) returns 400");
  r = await sandboxEnv({ dir: repoDir, home, extraEnv: { CI_CACHE_BRANCH: 'branch"with-quotes', CI_CACHE_ENV_FILE: join(work, "other.env") } });
  check(r.code === 0 && claims(r.loaded.TURBO_TOKEN).branch === 'branch"with-quotes', "CI_CACHE_BRANCH and CI_CACHE_ENV_FILE work (escaped quotes)");

  console.log("4. without jq (sed fallback)");
  const bin = join(work, "bin");
  mkdirSync(bin);
  for (const tool of ["bash", "curl", "git", "sed", "mktemp", "rm", "chmod", "env", "mv"]) {
    const found = (await run("bash", ["-c", `command -v ${tool}`])).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  await git("checkout", "-q", "feature/sandbox-e2e");
  r = await sandboxEnv({ dir: repoDir, home, path: bin });
  check(r.code === 0 && claims(r.loaded.TURBO_TOKEN).branch === "feature/sandbox-e2e", "works without jq");
  check(r.loaded.RUSTC_WRAPPER === undefined, "without sccache on PATH it doesn't export RUSTC_WRAPPER");

  console.log("5. bad key");
  const before = readFileSync(join(home, ".ci-cache.env"), "utf8");
  r = await sandboxEnv({ dir: repoDir, home, extraEnv: { CI_CACHE_SANDBOX_KEY: "sk_bad" } });
  check(r.code !== 0 && r.output.includes("401"), "fails with 401");
  check(readFileSync(join(home, ".ci-cache.env"), "utf8") === before, "doesn't touch the existing exports file");
  r = await sandboxEnv({ dir: repoDir, home, extraEnv: { CI_CACHE_SANDBOX_KEY: "" } });
  check(r.code !== 0 && r.output.includes("CI_CACHE_SANDBOX_KEY"), "without a key it fails with a clear message");

  console.log("6. sourcing ~/.ci-cache.env renews the session by itself");
  const file = join(home, ".ci-cache.env");
  r = await sandboxEnv({ dir: repoDir, home });
  check(r.code === 0, "a fresh session on feature/sandbox-e2e");
  check(!readFileSync(file, "utf8").includes(key), "the env file never holds the sandbox key");
  /** Sources the file in `shell` with `set -eu` from a directory outside the repo. */
  async function source({ shell = "bash", env = {}, pre = "" } = {}) {
    const strict = shell === "zsh" ? "setopt nounset errexit" : "set -eu";
    const script = `${strict}; ${pre} rc=0; . "${file}" || rc=$?; echo "rc=$rc token=\${TURBO_TOKEN:-} leftover=\${_cce_dir:-}\${_cce_why:-}"`;
    const out = await run(shell, ["-c", script], {
      cwd: work,
      env: { PATH: process.env.PATH, HOME: home, CI_CACHE_SANDBOX_KEY: key, SCCACHE_SERVER_PORT: "4999", ...env },
    });
    const m = /rc=(\d+) token=(\S*) leftover=(\S*)/.exec(out.stdout) ?? [];
    return { ...out, rc: Number(m[1] ?? -1), token: m[2] ?? "", leftover: m[3] ?? "" };
  }
  let s = await source({ pre: "set -o pipefail;" });
  check(s.code === 0 && s.rc === 0 && s.stderr === "" && claims(s.token).branch === "feature/sandbox-e2e", "same branch, fresh token: silent, under set -euo pipefail, from outside the repo");
  check(s.leftover === "", "leaves no helper variable behind");
  const first = s.token;

  await git("checkout", "-q", "-b", "feature/switched");
  s = await source();
  check(s.rc === 0 && s.stderr.includes("renewing the session") && s.stderr.includes("now on branch feature/switched"), "after git switch: renews and says why");
  check(claims(s.token).branch === "feature/switched" && s.token !== first, "the new token is for the new branch");
  check(!s.stdout.includes(key) && !s.stderr.includes(key) && !s.stderr.includes(s.token), "prints neither the key nor the token");
  s = await source();
  check(s.rc === 0 && s.stderr === "" && claims(s.token).branch === "feature/switched", "the next source is silent again");

  const renewed = s.token;
  writeFileSync(file, readFileSync(file, "utf8").replace(/_cce_exp=\d+/, "_cce_exp=1000"));
  s = await source();
  check(s.rc === 0 && s.stderr.includes("expires within 15 minutes") && s.token !== renewed && claims(s.token).branch === "feature/switched", "an expired token is renewed on the same branch");
  check(Number(/_cce_exp=(\d+)/.exec(readFileSync(file, "utf8"))?.[1]) > Date.now() / 1000, "and the file records the new expiry");

  s = await source({ env: { CI_CACHE_NO_REFRESH: "1" }, pre: "git -C '" + repoDir + "' checkout -q -b feature/no-refresh;" });
  check(s.rc === 0 && s.stderr === "" && claims(s.token).branch === "feature/switched", "CI_CACHE_NO_REFRESH=1 turns the renewal off");

  s = await source({ env: { CI_CACHE_SANDBOX_KEY: "sk_bad", TURBO_TOKEN: "stale" } });
  check(s.code === 0 && s.rc === 1 && s.stderr.includes("401") && s.stderr.includes("could not renew the session"), "a failed renewal: source returns 1 and says why (401)");
  check(s.token === "" && s.leftover === "", "and the old session is not left exported");
  s = await source({ env: { CI_CACHE_SANDBOX_KEY: "" } });
  check(s.rc === 1 && s.stderr.includes("CI_CACHE_SANDBOX_KEY is not set"), "without the key in the environment: a clear message");

  const shells = [];
  for (const sh of ["zsh", "dash", "sh"]) if ((await run("bash", ["-c", `command -v ${sh}`])).code === 0) shells.push(sh);
  for (const sh of shells) {
    await git("checkout", "-q", "-b", `feature/${sh}`);
    s = await source({ shell: sh });
    check(s.rc === 0 && claims(s.token).branch === `feature/${sh}` && s.leftover === "", `${sh}: renews after a switch, with nounset and errexit`);
  }
  if (!shells.includes("zsh")) console.log("  (no zsh here: not tested in zsh)");

  await git("checkout", "-q", "--detach");
  r = await sandboxEnv({ dir: repoDir, home, extraEnv: { CI_CACHE_BRANCH: "pinned/branch" } });
  s = await source({ pre: "git -C '" + repoDir + "' checkout -q feature/switched;" });
  check(r.code === 0 && s.rc === 0 && s.stderr === "" && claims(s.token).branch === "pinned/branch", "a branch pinned with CI_CACHE_BRANCH is kept: no renewal on a switch");

  console.log("e2e ci-cache-env.sh: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.VERBOSE) console.error(worker.log());
  process.exitCode = 1;
} finally {
  await worker.stop();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
