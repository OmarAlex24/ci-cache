import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { branchKey } from "../src/crypto.ts";
import type { SessionClaims } from "../src/session/token.ts";
import { TEST_REPO_ID, TEST_SANDBOX_KEY } from "./bindings.ts";
import { sessionToken } from "./helpers.ts";

const app = createApp({ jwks: createLocalJWKSet({ keys: [] }) });

let counter = 0;
/** Hash único por prueba (R2 local se comparte entre pruebas). */
function freshHash(): string {
  counter += 1;
  return `${Date.now().toString(16)}${counter.toString(16).padStart(4, "0")}abcdef`.slice(0, 32);
}

type Who = Partial<SessionClaims>;
const sandbox = (branch: string): Who => ({ tier: "rama", branch, kind: "sandbox" });
const pr = (branch: string): Who => ({ tier: "rama", branch, kind: "ci" });
const main: Who = { tier: "main", branch: "main", kind: "ci" };
const mainRo: Who = { tier: "main-ro", branch: "main", kind: "ci" };

async function call(who: Who | string, path: string, init: RequestInit = {}, customEnv: object = env) {
  const token = typeof who === "string" ? who : await sessionToken(who);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return app.request(path, { ...init, headers }, customEnv);
}

const byteLength = (body: string | Uint8Array) =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;

function put(who: Who, hash: string, body: string | Uint8Array, headers: Record<string, string> = {}) {
  return call(who, `/v8/artifacts/${hash}?teamId=team_x&slug=whatever`, {
    method: "PUT",
    body,
    // Los clientes reales mandan content-length; un Request creado en proceso no.
    headers: { "content-type": "application/octet-stream", "content-length": String(byteLength(body)), ...headers },
  });
}

describe("Turbo: auth", () => {
  it("todo /v8 exige token de sesión", async () => {
    expect((await app.request("/v8/artifacts/status", {}, env)).status).toBe(401);
    expect((await call(TEST_SANDBOX_KEY, "/v8/artifacts/status")).status).toBe(401);
    expect((await call("basura", "/v8/artifacts/abc")).status).toBe(401);
    expect((await call(main, "/v8/artifacts/status")).status).toBe(200);
  });

  it("status → enabled para todos los niveles", async () => {
    for (const who of [main, mainRo, sandbox("a"), pr("a")]) {
      expect(await (await call(who, "/v8/artifacts/status")).json()).toEqual({ status: "enabled" });
    }
  });
});

describe("Turbo: niveles y fallback", () => {
  it("sandbox escribe en su rama, PR de la misma rama acierta, main no lo ve", async () => {
    const hash = freshHash();
    const res = await put(sandbox("feature/a"), hash, "artefacto-rama", { "x-artifact-duration": "1234", "x-artifact-tag": "firma" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ urls: [expect.stringContaining(`/v8/artifacts/${hash}`)] });

    // Llave exacta en R2: ramas/<repoId>/<branchKey>/turbo/<hash>
    const key = `ramas/${TEST_REPO_ID}/${await branchKey("feature/a")}/turbo/${hash}`;
    const stored = await env.CACHE.head(key);
    expect(stored?.customMetadata).toEqual({ "x-artifact-duration": "1234", "x-artifact-tag": "firma", "writer-kind": "sandbox" });

    const hit = await call(pr("feature/a"), `/v8/artifacts/${hash}`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-artifact-duration")).toBe("1234");
    expect(hit.headers.get("x-artifact-tag")).toBe("firma");
    expect(hit.headers.get("content-type")).toBe("application/octet-stream");
    expect(await hit.text()).toBe("artefacto-rama");

    const head = await call(pr("feature/a"), `/v8/artifacts/${hash}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("artefacto-rama".length));
    expect(await head.text()).toBe("");

    for (const who of [main, mainRo, pr("feature/b")]) {
      const miss = await call(who, `/v8/artifacts/${hash}`);
      expect(miss.status).toBe(404);
      expect(await miss.json()).toMatchObject({ code: "not_found" });
      expect((await call(who, `/v8/artifacts/${hash}`, { method: "HEAD" })).status).toBe(404);
    }
  });

  it("main escribe en main/ y cualquier rama lo lee como fallback", async () => {
    const hash = freshHash();
    expect((await put(main, hash, "artefacto-main")).status).toBe(202);
    expect(await env.CACHE.head(`main/${TEST_REPO_ID}/turbo/${hash}`)).not.toBeNull();
    const fromBranch = await call(pr("otra-rama-nueva"), `/v8/artifacts/${hash}`);
    expect(fromBranch.status).toBe(200);
    expect(await fromBranch.text()).toBe("artefacto-main");
    expect((await call(mainRo, `/v8/artifacts/${hash}`)).status).toBe(200);
  });

  it("la rama propia gana sobre main/", async () => {
    const hash = freshHash();
    await put(main, hash, "de-main");
    await put(sandbox("feature/c"), hash, "de-rama");
    expect(await (await call(pr("feature/c"), `/v8/artifacts/${hash}`)).text()).toBe("de-rama");
    expect(await (await call(main, `/v8/artifacts/${hash}`)).text()).toBe("de-main");
  });

  it("main-ro no puede escribir (403)", async () => {
    const res = await put(mainRo, freshHash(), "x");
    expect(res.status).toBe(403);
    // Formato que entiende el cliente de turbo, además de { code, message }.
    expect(await res.json()).toEqual({
      code: "forbidden",
      message: "Este token solo puede leer main/",
      error: { code: "forbidden", message: "Este token solo puede leer main/" },
    });
  });

  it("sandbox en una rama llamada main escribe en ramas/, nunca en main/", async () => {
    const hash = freshHash();
    expect((await put(sandbox("main"), hash, "envenenado")).status).toBe(202);
    expect(await env.CACHE.head(`main/${TEST_REPO_ID}/turbo/${hash}`)).toBeNull();
    expect((await call(main, `/v8/artifacts/${hash}`)).status).toBe(404);
    expect((await call(pr("main"), `/v8/artifacts/${hash}`)).status).toBe(200);
  });

  it("otro repo no ve los artefactos", async () => {
    const hash = freshHash();
    await put(main, hash, "x");
    expect((await call({ ...main, repoId: 999 }, `/v8/artifacts/${hash}`)).status).toBe(404);
  });

  it("teamId/slug no cambian el prefijo", async () => {
    const hash = freshHash();
    await put(main, hash, "x");
    expect((await call(main, `/v8/artifacts/${hash}?teamId=otro`)).status).toBe(200);
    expect((await call(main, `/v8/artifacts/${hash}?slug=otro`)).status).toBe(200);
  });

  it("sube y baja 5 MB en streaming sin corromper", async () => {
    const hash = freshHash();
    const data = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    expect((await put(main, hash, data)).status).toBe(202);
    const back = new Uint8Array(await (await call(main, `/v8/artifacts/${hash}`)).arrayBuffer());
    expect(back.length).toBe(data.length);
    expect(back.every((v, i) => v === data[i])).toBe(true);
  });
});

describe("Turbo: validación", () => {
  it("rechaza hashes no hexadecimales o demasiado largos", async () => {
    for (const hash of ["xyz", "abc-def", "a".repeat(129), "..%2Fmain"]) {
      expect((await call(main, `/v8/artifacts/${hash}`)).status, hash).toBe(400);
      expect((await put(main, hash, "x")).status, hash).toBe(400);
    }
  });

  it("rechaza teamId con caracteres de control", async () => {
    expect((await call(main, "/v8/artifacts/status?teamId=a%00b")).status).toBe(400);
  });

  it("PUT sin content-length → 411", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
        controller.close();
      },
    });
    const res = await call(main, `/v8/artifacts/${freshHash()}`, { method: "PUT", body: stream });
    expect(res.status).toBe(411);
  });

  it("PUT por encima del tope → 413", async () => {
    const res = await call(main, `/v8/artifacts/${freshHash()}`, { method: "PUT", body: "0123456789A", headers: { "content-length": "11" } }, {
      ...env,
      MAX_ARTIFACT_BYTES: "10",
    });
    expect(res.status).toBe(413);
  });

  it("valida x-artifact-duration y x-artifact-tag", async () => {
    expect((await put(main, freshHash(), "x", { "x-artifact-duration": "-1" })).status).toBe(400);
    expect((await put(main, freshHash(), "x", { "x-artifact-tag": "t".repeat(601) })).status).toBe(400);
  });
});

describe("Turbo: consulta en lote y eventos", () => {
  it("POST /v8/artifacts aplica el fallback por hash", async () => {
    const own = freshHash();
    const fromMain = freshHash();
    const missing = freshHash();
    await put(sandbox("feature/q"), own, "aa", { "x-artifact-duration": "50", "x-artifact-tag": "t1" });
    await put(main, fromMain, "bbb", { "x-artifact-duration": "70" });
    const res = await call(pr("feature/q"), "/v8/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hashes: [own, fromMain, missing, "no-hex"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      [own]: { size: 2, taskDurationMs: 50, tag: "t1" },
      [fromMain]: { size: 3, taskDurationMs: 70 },
      [missing]: null,
      "no-hex": null,
    });
  });

  it("POST /v8/artifacts valida el cuerpo", async () => {
    for (const body of ["{}", '{"hashes":"x"}', '{"hashes":[1]}', "no-json"]) {
      const res = await call(main, "/v8/artifacts", { method: "POST", body, headers: { "content-type": "application/json" } });
      expect(res.status, body).toBe(400);
    }
  });

  it("POST /v8/artifacts/events acepta eventos válidos y rechaza basura", async () => {
    const ok = await call(main, "/v8/artifacts/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { sessionId: "6a0f8c3e-0000-4000-8000-000000000000", source: "REMOTE", event: "HIT", hash: "abc", duration: 10 },
        { source: "LOCAL", event: "MISS", hash: "def" },
      ]),
    });
    expect(ok.status).toBe(200);
    const bad = await call(main, "/v8/artifacts/events", { method: "POST", body: '[{"source":"X"}]' });
    expect(bad.status).toBe(400);
  });
});
