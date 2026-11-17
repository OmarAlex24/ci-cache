#!/usr/bin/env node
// Tests setup/setup.sh (the setup/action.yml step) outside GitHub Actions.
// GitHub's OIDC doesn't exist outside Actions, so a local server fakes the OIDC token
// endpoint and POST /v1/session (real OIDC verification is covered by the Worker's
// tests). With Docker, it also runs the script on Ubuntu to test the sccache install
// (SHA-256) and the mount --bind.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const SETUP = join(ROOT, "setup", "setup.sh");
const SESSION_TOKEN = "eyJ2IjoxfQ.ZmFrZS1zZXNzaW9u";
let sessionReply = { status: 200, body: {} };
const seen = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  seen.push(`${req.method} ${url.pathname}`);
  // Under /broken the sccache cache answers 500: the action must not enable sccache.
  if (url.pathname.startsWith("/broken/dav")) return res.writeHead(500).end();
  if (url.pathname.startsWith("/broken/")) url.pathname = url.pathname.slice("/broken".length);
  if (url.pathname === "/oidc") {
    const ok = req.headers.authorization === "bearer req-token" && url.searchParams.get("audience") === "ci-cache";
    res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
    return res.end(JSON.stringify(ok ? { value: "oidc.fake.jwt" } : { message: "no" }));
  }
  if (url.pathname === "/v1/session" && req.method === "POST") {
    const ok = req.headers.authorization === "Bearer oidc.fake.jwt";
    const reply = ok ? sessionReply : { status: 401, body: { code: "unauthorized", message: "Missing or invalid token" } };
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
    body: { token: SESSION_TOKEN, expiresAt: "2026-11-07T00:00:00.000Z", repoId: 1, repo: "acme/demo", tier, branch, kind: "ci" },
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
    GITHUB_REPOSITORY: "acme/demo",
    GITHUB_WORKSPACE: join(dir, "workspace"),
    ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
    INPUT_URL: `http://127.0.0.1:${port}/`,
    INPUT_AUDIENCE: "ci-cache",
    INPUT_SCCACHE: "false",
    INPUT_SCCACHE_VERSION: "0.19.0",
    INPUT_SCCACHE_SHA256: "",
    INPUT_MOUNT_WORKDIR: "false",
    RUNNER_TEMP: dir,
    ...inputs,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const result = await run("bash", [SETUP], { env });
  return { ...result, dir, out: result.stdout + result.stderr };
}

try {
  console.log("1. push to main");
  session("main", "main");
  let r = await setupOnHost("main");
  check(r.code === 0, "setup.sh exits cleanly");
  const masks = r.stdout.split("\n").filter((l) => l.startsWith("::add-mask::"));
  check(masks.includes("::add-mask::oidc.fake.jwt") && masks.includes(`::add-mask::${SESSION_TOKEN}`), "masks the OIDC and session tokens");
  const firstPlain = r.stdout.split("\n").findIndex((l) => l && !l.startsWith("::add-mask::"));
  check(firstPlain > r.stdout.split("\n").indexOf(`::add-mask::${SESSION_TOKEN}`), "masks before printing anything else");
  check(
    read(r.dir, "env") === `TURBO_API=http://127.0.0.1:${port}\nTURBO_TOKEN=${SESSION_TOKEN}\nTURBO_TEAM=demo\nTURBO_RUN_SUMMARY=true\n`,
    "exports TURBO_API (no trailing slash), TURBO_TOKEN, TURBO_TEAM=repo name and TURBO_RUN_SUMMARY",
  );
  check(read(r.dir, "ci-cache/session") === `tier=main\nbranch=main\nworkdir=${join(r.dir, "workspace")}\n`, "leaves the session state for the report action");
  check(read(r.dir, "output").includes("tier=main\nbranch=main\n") && read(r.dir, "output").includes(`workdir=${join(r.dir, "workspace")}`), "outputs tier, branch and workdir");

  r = await setupOnHost("no-summary", { INPUT_TURBO_SUMMARY: "false" });
  check(!read(r.dir, "env").includes("TURBO_RUN_SUMMARY"), "turbo-summary: false doesn't export TURBO_RUN_SUMMARY");
  r = await setupOnHost("user-summary", {}, { TURBO_RUN_SUMMARY: "false" });
  check(!read(r.dir, "env").includes("TURBO_RUN_SUMMARY"), "doesn't override a TURBO_RUN_SUMMARY the job already sets");

  console.log("2. main-ro (schedule)");
  session("main-ro", "main");
  r = await setupOnHost("main-ro");
  check(r.code === 0 && read(r.dir, "env").includes("TURBO_CACHE=local:rw,remote:r\n"), "main-ro exports TURBO_CACHE with a read-only remote");

  console.log("3. errors");
  r = await setupOnHost("no-id-token", {}, { ACTIONS_ID_TOKEN_REQUEST_URL: undefined });
  check(r.code !== 0 && r.out.includes("::error title=ci-cache::") && r.out.includes("id-token: write"), "without the id-token permission it fails with a clear message");
  r = await setupOnHost("401", {}, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "other" });
  check(r.code !== 0 && r.out.includes("could not request the OIDC token"), "fails if GitHub rejects the OIDC request");
  const realOidc = sessionReply;
  sessionReply = { status: 403, body: { code: "forbidden", message: "Repository not allowed" } };
  r = await setupOnHost("403");
  check(r.code !== 0 && r.out.includes("answered 403: Repository not allowed"), "a 403 from the Worker is shown with its message");
  check(read(r.dir, "env") === "", "and exports nothing");
  sessionReply = realOidc;
  r = await setupOnHost("bad-url", { INPUT_URL: "not a url" });
  check(r.code !== 0 && r.out.includes("invalid input url"), "validates the url input");

  console.log("4. sccache=auto");
  session("rama", "feature/x");
  r = await setupOnHost("auto-no-rust", { INPUT_SCCACHE: "auto" });
  check(r.code === 0 && !read(r.dir, "env").includes("RUSTC_WRAPPER"), "without Cargo.toml it doesn't set up sccache");

  console.log("5. mount-workdir=auto (default)");
  r = await setupOnHost("mount-auto-no-rust", { INPUT_MOUNT_WORKDIR: undefined });
  check(r.code === 0 && r.out.includes("mount-workdir auto: no Cargo.toml") && read(r.dir, "output").includes(`workdir=${join(r.dir, "workspace")}`), "the default is auto: without Cargo.toml it builds in GITHUB_WORKSPACE with a log line");
  if (process.platform !== "linux") {
    const rust = githubFiles("mount-auto-rust");
    writeFileSync(join(rust, "workspace", "Cargo.toml"), "[workspace]\n");
    const res = await run("bash", [SETUP], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_ENV: join(rust, "env"), GITHUB_OUTPUT: join(rust, "output"),
        GITHUB_PATH: join(rust, "path"), GITHUB_REPOSITORY: "acme/demo", GITHUB_WORKSPACE: join(rust, "workspace"),
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/oidc?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
        INPUT_URL: `http://127.0.0.1:${port}`, INPUT_SCCACHE: "false", INPUT_MOUNT_WORKDIR: "auto",
      },
    });
    check(res.code === 0 && (res.stdout + res.stderr).includes("mount-workdir auto: not Linux"), "with Cargo.toml off Linux it skips the mount with a log line");
  }

  const docker = await run("docker", ["info", "--format", "{{.Architecture}}"]).catch(() => ({ code: 1 }));
  if (docker.code !== 0) {
    console.log("  (no Docker: the sccache install and the mount on Linux are not tested)");
  } else {
    console.log("6. Linux (Docker, ubuntu:24.04): sccache by SHA-256 and mount --bind");
    const inner = [
      "set -e",
      "apt-get update -qq >/dev/null && apt-get install -y -qq curl jq ca-certificates >/dev/null",
      // Runners have passwordless sudo; in the container we are root.
      "printf '#!/bin/sh\\n[ \"$1\" = -n ] && shift\\nexec \"$@\"\\n' > /usr/local/bin/sudo && chmod +x /usr/local/bin/sudo",
      "mkdir -p /gh/workspace/crate && touch /gh/env /gh/output /gh/path",
      // Several Cargo.toml files (workspace + crates), like a real Rust repo.
      "mkdir -p /gh/workspace/crate2 /gh/workspace/a/b && echo '[workspace]' > /gh/workspace/Cargo.toml",
      "echo '[package]' > /gh/workspace/crate/Cargo.toml && echo '[package]' > /gh/workspace/crate2/Cargo.toml",
      "echo '[package]' > /gh/workspace/a/b/Cargo.toml && echo hello > /gh/workspace/marker.txt",
      "export GITHUB_ENV=/gh/env GITHUB_OUTPUT=/gh/output GITHUB_PATH=/gh/path GITHUB_REPOSITORY=acme/demo",
      "export GITHUB_WORKSPACE=/gh/workspace RUNNER_TOOL_CACHE=/opt/hostedtoolcache",
      `export ACTIONS_ID_TOKEN_REQUEST_URL='http://host.docker.internal:${port}/oidc?api-version=2.0' ACTIONS_ID_TOKEN_REQUEST_TOKEN=req-token`,
      `export INPUT_URL=http://host.docker.internal:${port} INPUT_AUDIENCE=ci-cache INPUT_SCCACHE=auto INPUT_SCCACHE_VERSION=0.19.0 INPUT_MOUNT_WORKDIR=true`,
      "bash /setup/setup.sh",
      'echo "== env"; cat /gh/env; echo "== output"; cat /gh/output; echo "== path"; cat /gh/path',
      'echo "== version"; "$(cat /gh/path)/sccache" --version',
      'echo "== mounted"; cat /home/user/demo/marker.txt',
      `"$(cat /gh/path)/sccache" --stop-server >/dev/null 2>&1 || true; : > /gh/env`,
      `INPUT_URL=http://host.docker.internal:${port}/broken INPUT_MOUNT_WORKDIR=false bash /setup/setup.sh; echo "== env broken"; cat /gh/env; echo "== end broken"`,
      // mount-workdir=auto with Cargo.toml: mounts; target not empty or no passwordless sudo: skips, exit 0.
      `: > /gh/output; GITHUB_REPOSITORY=acme/auto INPUT_MOUNT_WORKDIR=auto INPUT_SCCACHE=false bash /setup/setup.sh; echo "== auto"; cat /gh/output; cat /home/user/auto/marker.txt; echo "== end auto"`,
      `mkdir -p /home/user/full && touch /home/user/full/x && : > /gh/output; GITHUB_REPOSITORY=acme/full INPUT_MOUNT_WORKDIR=auto INPUT_SCCACHE=false bash /setup/setup.sh; echo "== full rc=$?"; cat /gh/output; echo "== end full"`,
      `mkdir -p /nosudo && printf '#!/bin/sh\\nexit 1\\n' > /nosudo/sudo && chmod +x /nosudo/sudo && : > /gh/output; PATH=/nosudo:$PATH GITHUB_REPOSITORY=acme/nosudo INPUT_MOUNT_WORKDIR=auto INPUT_SCCACHE=false bash /setup/setup.sh; echo "== nosudo rc=$?"; cat /gh/output; echo "== end nosudo"`,
      `PATH=/nosudo:$PATH GITHUB_REPOSITORY=acme/strict INPUT_MOUNT_WORKDIR=true INPUT_SCCACHE=false bash /setup/setup.sh && echo "STRICT DID NOT FAIL" || echo "== strict failed as expected"`,
      'echo "== bad sha"; : > /gh/env; rm -rf /opt/hostedtoolcache; INPUT_SCCACHE_SHA256=$(printf "0%.0s" $(seq 64)) bash /setup/setup.sh && echo "DID NOT FAIL" || echo "failed as expected"',
    ].join("\n");
    const res = await run("docker", [
      "run", "--rm", "--privileged", "--add-host=host.docker.internal:host-gateway",
      "-v", `${join(ROOT, "setup")}:/setup:ro`,
      "ubuntu:24.04", "bash", "-c", inner,
    ]);
    const out = res.stdout + res.stderr;
    if (process.env.VERBOSE) console.log(out);
    check(res.code === 0, "the script runs on Ubuntu");
    check(out.includes("RUSTC_WRAPPER=sccache") && out.includes(`SCCACHE_WEBDAV_ENDPOINT=http://host.docker.internal:${port}/dav`), "with Cargo.toml it exports RUSTC_WRAPPER and SCCACHE_WEBDAV_ENDPOINT");
    check(out.includes(`SCCACHE_WEBDAV_TOKEN=${SESSION_TOKEN}`) && out.includes("CARGO_INCREMENTAL=0"), "exports SCCACHE_WEBDAV_TOKEN and CARGO_INCREMENTAL=0");
    check(out.includes("SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true"), "exports SCCACHE_WEBDAV_DISABLE_CREATE_DIR=true");
    check(/== path\n\/opt\/hostedtoolcache\/sccache\/0\.19\.0\/(aarch64|x86_64)\n/.test(out), "adds sccache to GITHUB_PATH from the tool cache");
    check(out.includes("== version\nsccache 0.19.0"), "the installed binary is sccache 0.19.0");
    check(out.includes("workdir=/home/user/demo") && out.includes("== mounted\nhello"), "mounts the checkout at /home/user/<repo> and exposes it as workdir");
    const broken = out.split("== env broken")[1]?.split("== end broken")[0] ?? "RUSTC_WRAPPER";
    check(out.includes("sccache did not start against the remote cache") && !broken.includes("RUSTC_WRAPPER") && broken.includes("TURBO_TOKEN"), "if the sccache cache fails at startup, it doesn't enable sccache and keeps Turbo");
    check(out.includes("the sccache SHA-256 does not match") && out.includes("failed as expected"), "a mismatched SHA-256 aborts the install");
    const section = (name) => out.split(`== ${name}`)[1]?.split(`== end ${name}`)[0] ?? "";
    check(section("auto").includes("workdir=/home/user/auto") && section("auto").includes("hello"), "mount-workdir=auto with Cargo.toml mounts at /home/user/<repo>");
    check(out.includes("mount-workdir auto: /home/user/full exists and is not empty") && section("full").startsWith(" rc=0") && section("full").includes("workdir=/gh/workspace"), "auto with a non-empty target skips the mount, exit 0, workdir = GITHUB_WORKSPACE");
    check(out.includes("mount-workdir auto: no passwordless sudo") && section("nosudo").startsWith(" rc=0") && section("nosudo").includes("workdir=/gh/workspace"), "auto without passwordless sudo skips the mount, exit 0");
    check(out.includes("== strict failed as expected") && !out.includes("STRICT DID NOT FAIL"), "mount-workdir=true still fails loudly when it can't mount");
  }
  check(seen.includes("GET /oidc") && seen.includes("POST /v1/session"), "the script talked to the expected endpoints");
  console.log("e2e setup/action: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  server.close();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
