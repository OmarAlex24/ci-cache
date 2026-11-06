#!/usr/bin/env node
// Prueba setup/setup.sh (el paso de setup/action.yml) fuera de GitHub Actions.
// El OIDC de GitHub no existe fuera de Actions, así que un servidor local simula
// el endpoint de tokens OIDC y POST /v1/session (la verificación real del OIDC
// está cubierta por las pruebas del Worker). Con Docker, además, corre el script en
// Ubuntu para probar la instalación de sccache (SHA-256) y el mount --bind.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const SETUP = join(ROOT, "setup", "setup.sh");
const SESSION_TOKEN = "eyJ2IjoxfQ.c2Vzc2lvbi1zaW11bGFkYQ";
let sessionReply = { status: 200, body: {} };
const seen = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  seen.push(`${req.method} ${url.pathname}`);
  if (url.pathname === "/oidc") {
    const ok = req.headers.authorization === "bearer req-token" && url.searchParams.get("audience") === "ci-cache";
    res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
    return res.end(JSON.stringify(ok ? { value: "oidc.simulado.jwt" } : { message: "no" }));
  }
  if (url.pathname === "/v1/session" && req.method === "POST") {
    const ok = req.headers.authorization === "Bearer oidc.simulado.jwt";
    const reply = ok ? sessionReply : { status: 401, body: { code: "unauthorized", message: "Token ausente o inválido" } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    return res.end(JSON.stringify(reply.body));
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const port = server.address().port;
const work = mkdtempSync(join(tmpdir(), "ci-cache-setup-e2e-"));

function session(tier, branch) {
  sessionReply = {
    status: 200,
    body: { token: SESSION_TOKEN, expiresAt: "2026-11-07T00:00:00.000Z", repoId: 1, repo: "OmarAlex24/demo", tier, branch, kind: "ci" },
  };
}

function githubFiles(name) {
  const dir = join(work, name);
  mkdirSync(join(dir, "workspace"), { recursive: true });
  for (const file of ["env", "output", "path"]) writeFileSync(join(dir, file), "");
  return dir;
}

const read = (dir, file) => readFileSync(join(dir, file), "utf8");

async function setupOnHost(name, inputs = {}, extraEnv = {}) {
  const dir = githubFiles(name);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_ENV: join(dir, "env"),
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_PATH: join(dir, "path"),
    GITHUB_REPOSITORY: "OmarAlex24/demo",
    GITHUB_WORKSPACE: join(dir, "workspace"),
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
    INPUT_URL: `http://127.0.0.1:${port}/`,
    INPUT_AUDIENCE: "ci-cache",
    INPUT_SCCACHE: "false",
    INPUT_SCCACHE_VERSION: "0.19.0",
    INPUT_SCCACHE_SHA256: "",
    INPUT_MOUNT_WORKDIR: "false",
    ...inputs,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const result = await run("bash", [SETUP], { env });
  return { ...result, dir, out: result.stdout + result.stderr };
}

try {
  console.log("1. push a main");
  session("main", "main");
  let r = await setupOnHost("main");
  check(r.code === 0, "setup.sh termina bien");
  const masks = r.stdout.split("\n").filter((l) => l.startsWith("::add-mask::"));
  check(masks.includes("::add-mask::oidc.simulado.jwt") && masks.includes(`::add-mask::${SESSION_TOKEN}`), "enmascara el OIDC y el token de sesión");
  const firstPlain = r.stdout.split("\n").findIndex((l) => l && !l.startsWith("::add-mask::"));
  check(firstPlain > r.stdout.split("\n").indexOf(`::add-mask::${SESSION_TOKEN}`), "enmascara antes de imprimir cualquier otra cosa");
  check(
    read(r.dir, "env") === `TURBO_API=http://127.0.0.1:${port}\nTURBO_TOKEN=${SESSION_TOKEN}\nTURBO_TEAM=demo\n`,
    "exporta TURBO_API (sin barra final), TURBO_TOKEN y TURBO_TEAM=nombre del repo",
  );
  check(read(r.dir, "output").includes("tier=main\nbranch=main\n") && read(r.dir, "output").includes(`workdir=${join(r.dir, "workspace")}`), "outputs tier, branch y workdir");

  console.log("2. main-ro (schedule)");
  session("main-ro", "main");
  r = await setupOnHost("main-ro");
  check(r.code === 0 && read(r.dir, "env").includes("TURBO_CACHE=local:rw,remote:r\n"), "main-ro exporta TURBO_CACHE con remoto de solo lectura");

  console.log("3. errores");
  r = await setupOnHost("sin-id-token", {}, { ACTIONS_ID_TOKEN_REQUEST_URL: undefined });
  check(r.code !== 0 && r.out.includes("::error title=ci-cache::") && r.out.includes("id-token: write"), "sin permiso id-token falla con un mensaje claro");
  r = await setupOnHost("401", {}, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "otro" });
  check(r.code !== 0 && r.out.includes("no se pudo pedir el token OIDC"), "si GitHub rechaza la petición OIDC falla");
  const realOidc = sessionReply;
  sessionReply = { status: 403, body: { code: "forbidden", message: "Repositorio no permitido" } };
  r = await setupOnHost("403");
  check(r.code !== 0 && r.out.includes("respondió 403: Repositorio no permitido"), "un 403 del Worker se muestra con su mensaje");
  check(read(r.dir, "env") === "", "y no exporta nada");
  sessionReply = realOidc;
  r = await setupOnHost("url-mala", { INPUT_URL: "no es url" });
  check(r.code !== 0 && r.out.includes("input url inválido"), "valida el input url");

  console.log("4. sccache=auto");
  session("rama", "feature/x");
  r = await setupOnHost("auto-sin-rust", { INPUT_SCCACHE: "auto" });
  check(r.code === 0 && !read(r.dir, "env").includes("RUSTC_WRAPPER"), "sin Cargo.toml no configura sccache");

  const docker = await run("docker", ["info", "--format", "{{.Architecture}}"]).catch(() => ({ code: 1 }));
  if (docker.code !== 0) {
    console.log("  (sin Docker: no se prueba la instalación de sccache ni el mount en Linux)");
  } else {
    console.log("5. Linux (Docker, ubuntu:24.04): sccache por SHA-256 y mount --bind");
    const inner = [
      "set -e",
      "apt-get update -qq >/dev/null && apt-get install -y -qq curl jq ca-certificates >/dev/null",
      // Los runners tienen sudo sin contraseña; en el contenedor somos root.
      "printf '#!/bin/sh\\nexec \"$@\"\\n' > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo",
      "mkdir -p /gh/workspace/crate && touch /gh/env /gh/output /gh/path",
      // Varios Cargo.toml (workspace + crates), como un repo de Rust real.
      "mkdir -p /gh/workspace/crate2 /gh/workspace/a/b && echo '[workspace]' > /gh/workspace/Cargo.toml",
      "echo '[package]' > /gh/workspace/crate/Cargo.toml && echo '[package]' > /gh/workspace/crate2/Cargo.toml",
      "echo '[package]' > /gh/workspace/a/b/Cargo.toml && echo hola > /gh/workspace/marca.txt",
      "export GITHUB_ENV=/gh/env GITHUB_OUTPUT=/gh/output GITHUB_PATH=/gh/path GITHUB_REPOSITORY=OmarAlex24/demo",
      "export GITHUB_WORKSPACE=/gh/workspace RUNNER_TOOL_CACHE=/opt/hostedtoolcache",
      `export ACTIONS_ID_TOKEN_REQUEST_URL='http://host.docker.internal:${port}/oidc?api-version=2.0' ACTIONS_ID_TOKEN_REQUEST_TOKEN=req-token`,
      `export INPUT_URL=http://host.docker.internal:${port} INPUT_AUDIENCE=ci-cache INPUT_SCCACHE=auto INPUT_SCCACHE_VERSION=0.19.0 INPUT_MOUNT_WORKDIR=true`,
      "bash /setup/setup.sh",
      'echo "== env"; cat /gh/env; echo "== output"; cat /gh/output; echo "== path"; cat /gh/path',
      'echo "== version"; "$(cat /gh/path)/sccache" --version',
      'echo "== montado"; cat /home/user/demo/marca.txt',
      'echo "== sha malo"; : > /gh/env; rm -rf /opt/hostedtoolcache; INPUT_SCCACHE_SHA256=$(printf "0%.0s" $(seq 64)) bash /setup/setup.sh && echo "NO FALLÓ" || echo "falló como debe"',
    ].join("\n");
    const res = await run("docker", [
      "run", "--rm", "--privileged", "--add-host=host.docker.internal:host-gateway",
      "-v", `${join(ROOT, "setup")}:/setup:ro`,
      "ubuntu:24.04", "bash", "-c", inner,
    ]);
    const out = res.stdout + res.stderr;
    if (process.env.VERBOSE) console.log(out);
    check(res.code === 0, "el script corre en Ubuntu");
    check(out.includes("RUSTC_WRAPPER=sccache") && out.includes(`SCCACHE_WEBDAV_ENDPOINT=http://host.docker.internal:${port}/dav`), "con Cargo.toml exporta RUSTC_WRAPPER y SCCACHE_WEBDAV_ENDPOINT");
    check(out.includes(`SCCACHE_WEBDAV_TOKEN=${SESSION_TOKEN}`) && out.includes("CARGO_INCREMENTAL=0"), "exporta SCCACHE_WEBDAV_TOKEN y CARGO_INCREMENTAL=0");
    check(/== path\n\/opt\/hostedtoolcache\/sccache\/0\.19\.0\/(aarch64|x86_64)\n/.test(out), "agrega sccache al GITHUB_PATH desde la caché de herramientas");
    check(out.includes("== version\nsccache 0.19.0"), "el binario instalado es sccache 0.19.0");
    check(out.includes("workdir=/home/user/demo") && out.includes("== montado\nhola"), "monta el checkout en /home/user/<repo> y lo expone en workdir");
    check(out.includes("el SHA-256 de sccache no coincide") && out.includes("falló como debe"), "un SHA-256 que no coincide aborta la instalación");
  }
  check(seen.includes("GET /oidc") && seen.includes("POST /v1/session"), "el script habló con los endpoints esperados");
  console.log("e2e setup/action: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  server.close();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
