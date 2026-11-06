// Utilidades de las pruebas e2e: levantan `wrangler dev` aislado y firman tokens
// de sesión con el SESSION_SECRET de .dev.vars.
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
    throw new Error("Falta .dev.vars: copia .dev.vars.example y pon un SESSION_SECRET");
  }
  const vars = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  if (!vars.SESSION_SECRET) throw new Error(".dev.vars no tiene SESSION_SECRET");
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
 * Levanta `wrangler dev` con R2 local en un directorio temporal, o usa
 * CI_CACHE_URL si ya hay uno corriendo. `vars` se pasan con --var y tienen
 * prioridad sobre .dev.vars. Devuelve { url, log, stop }.
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
      // aún no está listo
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`wrangler dev no arrancó:\n${output}`);
}

/** Corre un comando y devuelve { code, stdout, stderr } (stdout+stderr también se imprimen si VERBOSE=1). */
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
  if (!condition) throw new Error(`FALLÓ: ${message}`);
  console.log(`  ok  ${message}`);
}
