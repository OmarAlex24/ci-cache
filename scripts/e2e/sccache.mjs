#!/usr/bin/env node
// e2e con sccache real (backend webdav) contra `wrangler dev` y R2 local:
//   1. sandbox (rama X) compila: fallos, escribe en ramas/
//   2. CI de PR de la rama X, con target/ limpio: aciertos
//   3. CI de main (push): NO lee la rama, falla y escribe en main/
//   4. CI de una rama nueva: aciertos desde main/
//   5. main-ro: sccache queda en solo lectura y acierta desde main/
// Al final imprime los verbos WebDAV que vio el Worker.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

import { check, mintSession, randomRepoId, run, startWorker } from "./lib.mjs";

const REPO = "OmarAlex24/e2e-sccache";

function writeCrates(dir) {
  const files = {
    "Cargo.toml": '[workspace]\nmembers = ["core", "app"]\nresolver = "2"\n',
    "core/Cargo.toml": '[package]\nname = "e2e_core"\nversion = "0.1.0"\nedition = "2021"\n',
    "core/src/lib.rs": "pub fn fib(n: u64) -> u64 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } }\n",
    "app/Cargo.toml":
      '[package]\nname = "e2e_app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ne2e_core = { path = "../core" }\n',
    "app/src/lib.rs": "pub fn answer() -> u64 { e2e_core::fib(10) }\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Quita los códigos de color ANSI del log de wrangler.
const stripAnsi = (text) => text.replaceAll(String.fromCharCode(27), "").replace(/\[[0-9;]*m/g, "");
const sum = (counts) => Object.values(counts ?? {}).reduce((a, b) => a + b, 0);

async function build(dir, url, token, serverPort) {
  const env = {
    ...process.env,
    SCCACHE_SERVER_PORT: String(serverPort),
    SCCACHE_WEBDAV_ENDPOINT: `${url}/dav`,
    SCCACHE_WEBDAV_TOKEN: token,
    // Como lo exportan setup.sh y ci-cache-env.sh: sin PROPFIND antes de cada PUT.
    SCCACHE_WEBDAV_DISABLE_CREATE_DIR: "true",
    SCCACHE_DIR: join(dir, ".sccache-local"),
    RUSTC_WRAPPER: "sccache",
    CARGO_INCREMENTAL: "0",
    CARGO_TARGET_DIR: join(dir, "target"),
  };
  delete env.SCCACHE_LOG;
  // El servidor de sccache se queda con el entorno con que arrancó: reiniciarlo por identidad.
  await run("sccache", ["--stop-server"], { env });
  const started = await run("sccache", ["--start-server"], { env });
  if (started.code !== 0) throw new Error(`sccache no arrancó: ${started.stderr}`);
  rmSync(join(dir, "target"), { recursive: true, force: true });
  const cargo = await run("cargo", ["build", "--quiet"], { cwd: dir, env });
  const json = JSON.parse((await run("sccache", ["--show-stats", "--stats-format=json"], { env })).stdout);
  await run("sccache", ["--stop-server"], { env });
  const s = json.stats;
  return {
    ok: cargo.code === 0,
    cargoErr: cargo.stderr,
    hits: sum(s.cache_hits.counts),
    misses: sum(s.cache_misses.counts),
    writes: s.cache_writes,
    writeErrors: s.cache_write_errors,
    readErrors: s.cache_read_errors,
    mode: json.effective_cache_mode,
  };
}

const worker = await startWorker();
const dir = mkdtempSync(join(tmpdir(), "ci-cache-sccache-e2e-"));
try {
  const version = (await run("sccache", ["--version"])).stdout.trim();
  console.log(`${version} · worker ${worker.url} · crates ${dir}`);
  writeCrates(dir);
  const serverPort = await freePort();
  const repoId = randomRepoId();
  const branch = `feature/e2e-${repoId}`;
  const id = (tier, b, kind) => mintSession({ repoId, repo: REPO, tier, branch: b, kind });
  const show = (r) => console.log(`  hits=${r.hits} misses=${r.misses} writes=${r.writes} write_errors=${r.writeErrors} mode=${JSON.stringify(r.mode)}`);

  console.log("1. sandbox compila en su rama");
  let r = await build(dir, worker.url, await id("rama", branch, "sandbox"), serverPort);
  show(r);
  check(r.ok, "cargo build termina bien");
  check(r.misses >= 2 && r.hits === 0 && r.writeErrors === 0 && r.writes >= 2, "sandbox: todo fallos y escribe sin errores");

  console.log("2. CI de PR de la misma rama, target/ limpio");
  r = await build(dir, worker.url, await id("rama", branch, "ci"), serverPort);
  show(r);
  check(r.ok && r.hits >= 2 && r.misses === 0, "PR: todo aciertos (lo escrito por el sandbox)");

  console.log("3. CI de main (push)");
  r = await build(dir, worker.url, await id("main", "main", "ci"), serverPort);
  show(r);
  check(r.ok && r.hits === 0 && r.misses >= 2 && r.writes >= 2, "main: no lee la rama, falla y escribe en main/");

  console.log("4. CI de una rama nueva");
  r = await build(dir, worker.url, await id("rama", `feature/otra-${repoId}`, "ci"), serverPort);
  show(r);
  check(r.ok && r.hits >= 2 && r.misses === 0, "rama nueva: aciertos desde main/");

  console.log("5. main-ro (schedule)");
  r = await build(dir, worker.url, await id("main-ro", "main", "ci"), serverPort);
  show(r);
  check(r.ok && r.hits >= 2 && r.writes === 0, "main-ro: lee main/ y no escribe");
  check(JSON.stringify(r.mode).includes("ReadOnly"), "main-ro: sccache detecta solo lectura");

  const verbs = new Map();
  for (const line of worker.log().split("\n")) {
    const match = /\b([A-Z]+) (\/dav\/\S*) (\d{3})/.exec(stripAnsi(line));
    if (!match) continue;
    const shape = match[2].replace(/[0-9a-f]{32,}/, "<hash>").replace(/^\/dav\/[0-9a-f]\/[0-9a-f]\/[0-9a-f]\//, "/dav/x/y/z/");
    const key = `${match[1]} ${shape} ${match[3]}`;
    verbs.set(key, (verbs.get(key) ?? 0) + 1);
  }
  console.log("verbos WebDAV vistos por el Worker:");
  for (const [key, count] of [...verbs].sort()) console.log(`  ${String(count).padStart(3)}  ${key}`);
  check(![...verbs.keys()].some((k) => k.endsWith(" 405")), "ningún verbo sin implementar (405)");
  check(![...verbs.keys()].some((k) => k.startsWith("PROPFIND ")), "sin PROPFIND (SCCACHE_WEBDAV_DISABLE_CREATE_DIR)");
  console.log("e2e sccache: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  if (process.env.VERBOSE) console.error(worker.log());
  process.exitCode = 1;
} finally {
  await worker.stop();
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}
