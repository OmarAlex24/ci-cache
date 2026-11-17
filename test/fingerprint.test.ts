import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { branchKey } from "../src/crypto.ts";
import { MAX_FINGERPRINT_BYTES } from "../src/fingerprint/routes.ts";
import type { SessionClaims } from "../src/session/token.ts";
import { TEST_REPO_ID } from "./bindings.ts";
import { sessionToken } from "./helpers.ts";

type Who = Partial<SessionClaims>;
const app = createApp({ jwks: createLocalJWKSet({ keys: [] }) });
const metrics: AnalyticsEngineDataPoint[] = [];
const testEnv = { ...env, METRICS: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => void metrics.push(p!) } };

let n = 0;
const fresh = (name: string) => `${name}-${Date.now()}-${++n}`;
const sandbox = (branch: string): Who => ({ tier: "rama", branch, kind: "sandbox" });
const pr = (branch: string): Who => ({ tier: "rama", branch, kind: "ci" });
const main: Who = { tier: "main", branch: "main", kind: "ci" };
const mainRo: Who = { tier: "main-ro", branch: "main", kind: "ci" };

async function put(who: Who, body: string | Uint8Array, headers: Record<string, string> = {}) {
  return app.request(
    "/v1/fingerprint",
    {
      method: "PUT",
      headers: { authorization: `Bearer ${await sessionToken(who)}`, "content-type": "text/plain", ...headers },
      body,
    },
    testEnv,
  );
}

async function get(who: Who) {
  return app.request("/v1/fingerprint", { headers: { authorization: `Bearer ${await sessionToken(who)}` } }, testEnv);
}

describe("/v1/fingerprint", () => {
  it("a sandbox writes under its branch; that branch's CI reads it", async () => {
    const branch = fresh("feature/fp");
    expect((await put(sandbox(branch), "RUSTFLAGS=-Dwarnings\n")).status).toBe(204);
    const stored = await env.CACHE.get(`ramas/${TEST_REPO_ID}/${await branchKey(branch)}/fingerprint/sandbox`);
    expect(await stored?.text()).toBe("RUSTFLAGS=-Dwarnings\n");

    const res = await get(pr(branch));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-fingerprint-kind")).toBe("sandbox");
    expect(res.headers.get("x-fingerprint-source")).toBe("branch");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("RUSTFLAGS=-Dwarnings\n");
  });

  it("CI reads only its own branch's sandbox fingerprint, never its own or another branch's", async () => {
    const branch = fresh("feature/a");
    await put(sandbox(fresh("feature/other")), "other");
    await put(pr(branch), "ci's own");
    expect((await get(pr(branch))).status).toBe(404);
  });

  it("branch CI writes fingerprint/ci; the sandbox reads it, falling back to main's", async () => {
    const branch = fresh("feature/b");
    const repoId = TEST_REPO_ID + 1000 + n;
    expect((await get({ ...sandbox(branch), repoId })).status).toBe(404);
    expect((await put({ ...main, repoId }, "main ci")).status).toBe(204);
    expect(await env.CACHE.head(`main/${repoId}/fingerprint/ci`)).not.toBeNull();
    let res = await get({ ...sandbox(branch), repoId });
    expect(res.headers.get("x-fingerprint-source")).toBe("main");
    expect(await res.text()).toBe("main ci");

    expect((await put({ ...pr(branch), repoId }, "branch ci")).status).toBe(204);
    res = await get({ ...sandbox(branch), repoId });
    expect(res.headers.get("x-fingerprint-kind")).toBe("ci");
    expect(res.headers.get("x-fingerprint-source")).toBe("branch");
    expect(await res.text()).toBe("branch ci");
  });

  it("main-ro cannot write; main and main-ro have nothing to compare against", async () => {
    expect((await put(mainRo, "x")).status).toBe(403);
    expect((await get(mainRo)).status).toBe(404);
    expect((await get(main)).status).toBe(404);
  });

  it("caps the body at 64 KB by real size (413) and rejects an empty one", async () => {
    const big = "x".repeat(MAX_FINGERPRINT_BYTES + 1);
    expect((await put(sandbox(fresh("f")), big)).status).toBe(413);
    expect((await put(sandbox(fresh("f")), "x", { "content-length": String(MAX_FINGERPRINT_BYTES + 1) })).status).toBe(413);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const chunked = await app.request(
      "/v1/fingerprint",
      // @ts-expect-error duplex is required by undici for streaming bodies
      { method: "PUT", headers: { authorization: `Bearer ${await sessionToken(sandbox(fresh("f")))}` }, body: stream, duplex: "half" },
      testEnv,
    );
    expect(chunked.status).toBe(413);
    expect((await put(sandbox(fresh("f")), "x".repeat(MAX_FINGERPRINT_BYTES))).status).toBe(204);
    expect((await put(sandbox(fresh("f")), "")).status).toBe(400);
  });

  it("requires a session: no token, an rk_ key or a sandbox key get 401", async () => {
    expect((await app.request("/v1/fingerprint", {}, testEnv)).status).toBe(401);
    expect((await app.request("/v1/fingerprint", { method: "PUT", body: "x" }, testEnv)).status).toBe(401);
    const bad = await app.request("/v1/fingerprint", { headers: { authorization: "Bearer sk_nope" } }, testEnv);
    expect(bad.status).toBe(401);
  });

  it("the request cannot pick the branch or the kind (query and headers are ignored)", async () => {
    const victim = fresh("feature/victim");
    await put(sandbox(victim), "victim");
    const attacker = fresh("feature/attacker");
    const res = await app.request(
      `/v1/fingerprint?branch=${encodeURIComponent(victim)}&kind=sandbox`,
      { headers: { authorization: `Bearer ${await sessionToken(pr(attacker))}`, "x-branch": victim } },
      testEnv,
    );
    expect(res.status).toBe(404);
  });

  it("never records a metric (fingerprints are not cache hits or misses)", async () => {
    metrics.length = 0;
    const branch = fresh("feature/m");
    await put(sandbox(branch), "x");
    await get(pr(branch));
    await get(pr(fresh("none")));
    expect(metrics).toEqual([]);
  });
});
