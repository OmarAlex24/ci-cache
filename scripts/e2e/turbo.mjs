#!/usr/bin/env node
// e2e con el binario real de turbo contra `wrangler dev` y R2 local.
// Recorre el flujo anti-envenenamiento:
//   1. sandbox (rama X) falla y escribe en ramas/
//   2. CI de PR de la rama X acierta
//   3. CI de main (push) NO acierta (no lee ramas/) y escribe en main/
//   4. CI de una rama nueva acierta desde main/
//   5. main-ro (schedule) lee main/ y no puede escribir
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, mintSession, randomRepoId, ROOT, run, startWorker } from "./lib.mjs";

const TURBO = join(ROOT, "node_modules", ".bin", "turbo");
const REPO = "OmarAlex24/e2e-turbo";

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
      'const fs = require("node:fs");\nfs.mkdirSync("dist", { recursive: true });\nfs.writeFileSync("dist/out.txt", "compilado " + require("./input.json").value);\nconsole.log("BUILD EJECUTADO");\n',
    "packages/app/input.json": JSON.stringify({ value: 1 }),
    ".gitignore": "node_modules\ndist\n.turbo\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

async function turbo(dir, url, token) {
  rmSync(join(dir, "packages/app/dist"), { recursive: true, force: true });
  rmSync(join(dir, ".turbo"), { recursive: true, force: true });
  rmSync(join(dir, "packages/app/.turbo"), { recursive: true, force: true });
  const result = await run(TURBO, ["run", "build", "--cache=remote:rw", "--output-logs=full"], {
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
    },
  });
  const out = result.stdout + result.stderr;
  // Un acierto reproduce los logs guardados, así que "ejecutó" se mide con "cache miss, executing".
  const hit = /cache hit, replaying/i.test(out);
  const miss = /cache miss, executing/i.test(out);
  let restored = null;
  try {
    restored = readFileSync(join(dir, "packages/app/dist/out.txt"), "utf8");
  } catch {
    // sin salida
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

  console.log("1. sandbox en la rama escribe");
  let r = await turbo(dir, worker.url, await id("rama", branch, "sandbox"));
  check(r.code === 0, "turbo termina bien");
  check(r.miss && !r.hit && r.executed, "sandbox: cache miss y ejecuta el build");

  console.log("2. CI de PR de la misma rama");
  r = await turbo(dir, worker.url, await id("rama", branch, "ci"));
  check(r.code === 0 && r.hit && !r.executed, "PR: cache hit sin ejecutar el build");
  check(r.restored === "compilado 1", "PR: restaura dist/out.txt desde la caché remota");

  console.log("3. CI de main (push)");
  r = await turbo(dir, worker.url, await id("main", "main", "ci"));
  check(r.code === 0 && r.miss && r.executed, "main: NO acierta con lo de la rama (no lee ramas/) y ejecuta");

  console.log("4. CI de una rama nueva");
  r = await turbo(dir, worker.url, await id("rama", `feature/otra-${repoId}`, "ci"));
  check(r.code === 0 && r.hit && !r.executed, "rama nueva: acierta desde main/");

  console.log("5. main-ro (schedule)");
  r = await turbo(dir, worker.url, await id("main-ro", "main", "ci"));
  check(r.code === 0 && r.hit, "main-ro: lee main/");
  writeFileSync(join(dir, "packages/app/input.json"), JSON.stringify({ value: 2 }));
  r = await turbo(dir, worker.url, await id("main-ro", "main", "ci"));
  check(r.code === 0 && r.miss && r.executed, "main-ro: con entrada nueva falla, ejecuta y el run no se rompe por el 403");
  const warn = r.out.split("\n").filter((line) => /403|forbidden|failed|error/i.test(line));
  console.log(`  (turbo ante el 403: ${warn.length ? warn.join(" | ").slice(0, 300) : "sin avisos"})`);
  r = await turbo(dir, worker.url, await id("main", "main", "ci"));
  check(r.miss && r.executed, "main: lo que intentó main-ro no quedó escrito");

  const putLines = worker.log().split("\n").filter((line) => /PUT \/v8\/artifacts/.test(line));
  console.log(`  peticiones PUT vistas por el Worker: ${putLines.map((l) => l.replace(/.*PUT/, "PUT").replace(/\/v8\/artifacts\/\w+/, "/v8/artifacts/<hash>")).join(" · ")}`);
  console.log("e2e turbo: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.VERBOSE) console.error(worker.log());
  process.exitCode = 1;
} finally {
  await worker.stop();
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
