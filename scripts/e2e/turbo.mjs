#!/usr/bin/env node
// e2e with the real turbo binary against `wrangler dev` and local R2.
// Walks through the anti-poisoning flow:
//   1. sandbox (branch X) misses and writes to ramas/
//   2. PR CI on branch X hits
//   3. main CI (push) does NOT hit (it doesn't read ramas/) and writes to main/
//   4. CI on a new branch hits from main/
//   5. main-ro (schedule) reads main/ and, with TURBO_CACHE=remote:r, doesn't even try to write
//   6. main-ro without remote:r gets a 403 and leaves nothing written
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, mintSession, randomRepoId, ROOT, run, startWorker } from "./lib.mjs";

const TURBO = join(ROOT, "node_modules", ".bin", "turbo");
const REPO = "acme/e2e-turbo";

function writeFixture(dir) {
  const files = {
    "package.json": JSON.stringify(
      { name: "e2e-root", private: true, packageManager: "npm@10.9.2", workspaces: ["packages/*"] },
      null,
      2,
    ),
    "turbo.json": JSON.stringify({ tasks: { build: { outputs: ["dist/**"] } } }, null, 2),
    "packages/app/package.json": JSON.stringify({ name: "app", version: "1.0.0", scripts: { build: "node build.js" } }, null, 2),
    "packages/app/build.js":
      'const fs = require("node:fs");\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/out.txt", "built " + require("./input.json").value);\nconsole.log("BUILD EXECUTED");\n',
    "packages/app/input.json": JSON.stringify({ value: 1 }),
    ".gitignore": "node_modules\ndist\n.turbo\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

async function turbo(dir, url, token, extraEnv = {}) {
  rmSync(join(dir, "packages/app/dist"), { recursive: true, force: true });
  rmSync(join(dir, ".turbo"), { recursive: true, force: true });
  rmSync(join(dir, "packages/app/.turbo"), { recursive: true, force: true });
  // Remote cache only by default (no local cache) so every step exercises the Worker.
  const cacheFlag = extraEnv.TURBO_CACHE ? [] : ["--cache=remote:rw"];
  const result = await run(TURBO, ["run", "build", ...cacheFlag, "--output-logs=full"], {
    cwd: dir,
    env: {
      ...process.env,
      TURBO_API: url,
      TURBO_TOKEN: token,
      TURBO_TEAM: REPO.split("/")[1],
      TURBO_TELEMETRY_DISABLED: "1",
      TURBO_NO_UPDATE_NOTIFIER: "1",
      DO_NOT_TRACK: "1",
      CI: "1",
      ...extraEnv,
    },
  });
  const out = result.stdout + result.stderr;
  // A hit replays the stored logs, so "executed" is measured with "cache miss, executing".
  const hit = /cache hit, replaying/i.test(out);
  const miss = /cache miss, executing/i.test(out);
  let restored = null;
  try {
    restored = readFileSync(join(dir, "packages/app/dist/out.txt"), "utf8");
  } catch {
    // no output
  }
  return { code: result.code, out, hit, miss, executed: miss, restored };
}

const worker = await startWorker();
const dir = mkdtempSync(join(tmpdir(), "ci-cache-turbo-e2e-"));
try {
  const version = (await run(TURBO, ["--version"])).stdout.trim();
  console.log(`turbo ${version} · worker ${worker.url} · fixture ${dir}`);
  writeFixture(dir);
  await run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: dir });
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["-c", "user.email=e2e@local", "-c", "user.name=e2e", "commit", "-qm", "fixture"], { cwd: dir });

  const repoId = randomRepoId();
  const branch = `feature/e2e-${repoId}`;
  const id = (tier, b, kind) => mintSession({ repoId, repo: REPO, tier, branch: b, kind });

  console.log("1. sandbox on the branch writes");
  let r = await turbo(dir, worker.url, await id("rama", branch, "sandbox"));
  check(r.code === 0, "turbo exits cleanly");
  check(r.miss && !r.hit && r.executed, "sandbox: cache miss and runs the build");

  console.log("2. PR CI on the same branch");
  r = await turbo(dir, worker.url, await id("rama", branch, "ci"));
  check(r.code === 0 && r.hit && !r.executed, "PR: cache hit without running the build");
  check(r.restored === "built 1", "PR: restores dist/out.txt from the remote cache");

  console.log("3. main CI (push)");
  r = await turbo(dir, worker.url, await id("main", "main", "ci"));
  check(r.code === 0 && r.miss && r.executed, "main: does NOT hit the branch's output (doesn't read ramas/) and runs");

  console.log("4. CI on a new branch");
  r = await turbo(dir, worker.url, await id("rama", `feature/other-${repoId}`, "ci"));
  check(r.code === 0 && r.hit && !r.executed, "new branch: hits from main/");

  console.log("5. main-ro (schedule) with TURBO_CACHE=remote:r, as setup/action.yml configures it");
  const readOnly = { TURBO_CACHE: "remote:r" };
  const puts = () => worker.log().split("\n").filter((line) => /PUT \/v8\/artifacts/.test(line)).length;
  r = await turbo(dir, worker.url, await id("main-ro", "main", "ci"), readOnly);
  check(r.code === 0 && r.hit, "main-ro: reads main/");
  writeFileSync(join(dir, "packages/app/input.json"), JSON.stringify({ value: 2 }));
  const before = puts();
  r = await turbo(dir, worker.url, await id("main-ro", "main", "ci"), readOnly);
  check(r.code === 0 && r.miss && r.executed, "main-ro: with a new input misses and runs");
  check(puts() === before, "main-ro: with remote:r turbo doesn't try to write (no PUT)");

  console.log("6. main-ro WITHOUT remote:r: the 403 turns off the remote cache for the run");
  r = await turbo(dir, worker.url, await id("main-ro", "main", "ci"));
  check(r.code === 0 && r.miss, "main-ro: the run doesn't break on the 403");
  const warn = r.out.split("\n").filter((line) => /403/.test(line));
  console.log(`  (turbo: ${warn.join(" | ").trim().slice(0, 200)})`);
  r = await turbo(dir, worker.url, await id("main", "main", "ci"));
  check(r.miss && r.executed, "main: what main-ro tried was not written");

  const putLines = worker.log().split("\n").filter((line) => /PUT \/v8\/artifacts/.test(line));
  console.log(`  PUT requests seen by the Worker: ${putLines.map((l) => l.replace(/.*PUT/, "PUT").replace(/\/v8\/artifacts\/\w+/, "/v8/artifacts/<hash>")).join(" · ")}`);
  console.log("e2e turbo: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.VERBOSE) console.error(worker.log());
  process.exitCode = 1;
} finally {
  await worker.stop();
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
