// e2e test utilities: start an isolated `wrangler dev` and sign session tokens with
// the SESSION_SECRET from .dev.vars.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signSession } from "../../src/session/token.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readDevVars() {
  let text;
  try {
    text = readFileSync(join(ROOT, ".dev.vars"), "utf8");
  } catch {
    throw new Error("Missing .dev.vars: copy .dev.vars.example and set a SESSION_SECRET");
  }
  const vars = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  if (!vars.SESSION_SECRET) throw new Error(".dev.vars has no SESSION_SECRET");
  return vars;
}

export async function mintSession({ repoId, repo, tier, branch, kind, ttlSeconds = 3600 }) {
  const { SESSION_SECRET } = readDevVars();
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return signSession({ v: 1, repoId, repo, tier, branch, kind, exp }, SESSION_SECRET);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts `wrangler dev` with local R2 in a temporary directory, or uses
 * CI_CACHE_URL if one is already running. `vars` are passed with --var and take
 * precedence over .dev.vars. Returns { url, log, stop }.
 */
export async function startWorker({ vars = {} } = {}) {
  if (process.env.CI_CACHE_URL && Object.keys(vars).length === 0) {
    return { url: process.env.CI_CACHE_URL.replace(/\/$/, ""), log: () => "", stop: async () => {} };
  }
  readDevVars();
  const port = await freePort();
  const persist = mkdtempSync(join(tmpdir(), "ci-cache-state-"));
  const child = spawn(
    join(ROOT, "node_modules", ".bin", "wrangler"),
    [
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      persist,
      "--log-level",
      "info",
      ...Object.entries(vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) {
        return {
          url,
          log: () => output,
          stop: async () => {
            child.kill("SIGINT");
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (child.exitCode === null) child.kill("SIGKILL");
          },
        };
      }
    } catch {
      // not ready yet
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`wrangler dev did not start:\n${output}`);
}

/** Runs a command and returns { code, stdout, stderr } (stdout+stderr are also printed if VERBOSE=1). */
export function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (process.env.VERBOSE) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (process.env.VERBOSE) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function randomRepoId() {
  return 100_000_000 + Math.floor(Math.random() * 800_000_000);
}

export function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}
