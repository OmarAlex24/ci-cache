import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { branchKey } from "../src/crypto.ts";
import { parseDavPath } from "../src/dav/routes.ts";
import type { SessionClaims } from "../src/session/token.ts";
import { TEST_REPO_ID, TEST_SANDBOX_KEY } from "./bindings.ts";
import { sessionToken } from "./helpers.ts";

const app = createApp({ jwks: createLocalJWKSet({ keys: [] }) });

type Who = Partial<SessionClaims>;
const sandbox = (branch: string): Who => ({ tier: "rama", branch, kind: "sandbox" });
const pr = (branch: string): Who => ({ tier: "rama", branch, kind: "ci" });
const main: Who = { tier: "main", branch: "main", kind: "ci" };
const mainRo: Who = { tier: "main-ro", branch: "main", kind: "ci" };

let counter = 0;
const freshPath = () => `a/b/c/${Date.now().toString(16)}${(++counter).toString(16).padStart(6, "0")}`;

async function dav(who: Who | string, method: string, path: string, init: RequestInit = {}) {
  const token = typeof who === "string" ? who : await sessionToken(who);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return app.request(path, { ...init, method, headers }, env);
}

const put = (who: Who, path: string, body: string) =>
  dav(who, "PUT", `/dav/${path}`, { body, headers: { "content-length": String(new TextEncoder().encode(body).length) } });

describe("WebDAV para sccache", () => {
  it("exige token de sesión", async () => {
    expect((await app.request("/dav/.sccache_check", {}, env)).status).toBe(401);
    expect((await dav(TEST_SANDBOX_KEY, "GET", "/dav/.sccache_check")).status).toBe(401);
    expect((await dav("x.y", "PROPFIND", "/dav/", { headers: { depth: "0" } })).status).toBe(401);
  });

  it("sandbox escribe en su rama; PR de la rama lee; main no", async () => {
    const path = freshPath();
    expect((await put(sandbox("feature/s"), path, "objeto")).status).toBe(201);
    const stored = await env.CACHE.head(`ramas/${TEST_REPO_ID}/${await branchKey("feature/s")}/sccache/${path}`);
    expect(stored?.customMetadata).toEqual({ "writer-kind": "sandbox" });

    const hit = await dav(pr("feature/s"), "GET", `/dav/${path}`);
    expect(hit.status).toBe(200);
    expect(await hit.text()).toBe("objeto");
    expect((await dav(main, "GET", `/dav/${path}`)).status).toBe(404);
    expect((await dav(mainRo, "GET", `/dav/${path}`)).status).toBe(404);
    expect((await dav(pr("feature/otra"), "GET", `/dav/${path}`)).status).toBe(404);
  });

  it("main escribe en main/ y las ramas caen a main/", async () => {
    const path = freshPath();
    expect((await put(main, path, "de-main")).status).toBe(201);
    expect(await env.CACHE.head(`main/${TEST_REPO_ID}/sccache/${path}`)).not.toBeNull();
    expect(await (await dav(pr("rama-nueva"), "GET", `/dav/${path}`)).text()).toBe("de-main");
    expect((await dav(mainRo, "GET", `/dav/${path}`)).status).toBe(200);
  });

  it("main-ro no escribe (sccache queda en solo lectura)", async () => {
    expect((await put(mainRo, ".sccache_check", "Hello, World!")).status).toBe(403);
  });

  it("los prefijos de turbo y sccache no se mezclan", async () => {
    const hash = `${Date.now().toString(16)}ab`;
    await put(main, hash, "dav");
    const turbo = await app.request(`/v8/artifacts/${hash}`, { headers: { authorization: `Bearer ${await sessionToken(main)}` } }, env);
    expect(turbo.status).toBe(404);
  });

  it("tolera la doble barra que manda sccache si el endpoint termina en /", async () => {
    await put(sandbox("feature/dbl"), ".sccache_check", "Hello, World!");
    expect((await dav(pr("feature/dbl"), "GET", "/dav//.sccache_check")).status).toBe(200);
  });

  it("PROPFIND Depth 0 sobre un directorio responde 207 con colección y getlastmodified", async () => {
    for (const path of ["/dav/", "/dav//", "/dav/8/e/f/"]) {
      const res = await dav(mainRo, "PROPFIND", path, { headers: { depth: "0" } });
      expect(res.status, path).toBe(207);
      expect(res.headers.get("content-type")).toContain("application/xml");
      const xml = await res.text();
      expect(xml).toContain("<D:collection/>");
      expect(xml).toContain("<D:getlastmodified>Thu, 01 Jan 1970 00:00:00 GMT</D:getlastmodified>");
      expect(xml).toContain(`<D:href>${path}</D:href>`);
    }
  });

  it("PROPFIND sin Depth 0 (listados) → 403; sobre archivo → 404", async () => {
    expect((await dav(main, "PROPFIND", "/dav/", { headers: { depth: "1" } })).status).toBe(403);
    expect((await dav(main, "PROPFIND", "/dav/", { headers: { depth: "infinity" } })).status).toBe(403);
    expect((await dav(main, "PROPFIND", "/dav/")).status).toBe(403);
    expect((await dav(main, "PROPFIND", "/dav/a/b", { headers: { depth: "0" } })).status).toBe(404);
  });

  it("verbos no usados por sccache → 405", async () => {
    for (const method of ["MKCOL", "DELETE", "MOVE", "COPY", "PROPPATCH", "POST"]) {
      expect((await dav(main, method, "/dav/x")).status, method).toBe(405);
    }
  });

  it("PUT sin content-length → 411; sobre directorio → 400", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    expect((await dav(main, "PUT", "/dav/x", { body: stream })).status).toBe(411);
    expect((await dav(main, "PUT", "/dav/x/", { body: "a", headers: { "content-length": "1" } })).status).toBe(400);
  });

  it("valida la ruta", async () => {
    for (const path of ["/dav/a%20b", "/dav/a/%00", `/dav/${"a".repeat(129)}`, `/dav/${"ab/".repeat(200)}x`]) {
      expect((await dav(main, "GET", path)).status, path).toBe(400);
    }
    expect(() => parseDavPath("/dav/a/../b")).toThrow();
    expect(() => parseDavPath("/dav/./b")).toThrow();
    expect(() => parseDavPath("/davx")).toThrow();
    expect(parseDavPath("/dav//8/e/f/abc")).toEqual({ path: "8/e/f/abc", isDir: false });
    expect(parseDavPath("/dav")).toEqual({ path: "", isDir: true });
  });

  it("Server-Timing separa sesión, cada lectura de R2 y el total", async () => {
    const path = freshPath();
    await put(sandbox("feature/st"), path, "x");
    const timings = (res: Response) =>
      (res.headers.get("server-timing") ?? "").split(",").map((entry) => entry.split(";")[0]);

    const own = await dav(pr("feature/st"), "GET", `/dav/${path}`);
    expect(own.status).toBe(200);
    expect(timings(own)).toEqual(expect.arrayContaining(["session", "r2-own", "total"]));
    expect(timings(own)).not.toContain("r2-main");

    // Fallo en la rama: lee la rama y luego main/.
    const miss = await dav(pr("feature/st-otra"), "GET", `/dav/${path}`);
    expect(miss.status).toBe(404);
    expect(timings(miss)).toEqual(expect.arrayContaining(["session", "r2-own", "r2-main", "total"]));
    expect(own.headers.get("server-timing")).toMatch(/r2-own;dur=[0-9.]+/u);
  });
});
