import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import type { SessionClaims } from "../src/session/token.ts";
import { cloudflareAnalytics, type AnalyticsClient } from "../src/stats/analytics.ts";
import { branchesSql, shapeBranches, shapeStats, statsSql } from "../src/stats/queries.ts";
import { TEST_REPO_ID, TEST_SANDBOX_KEY, TEST_STATS_KEY, TEST_STATS_KEY_4242 } from "./bindings.ts";
import { sessionToken } from "./helpers.ts";

type Who = Partial<SessionClaims>;
const sandbox = (branch: string): Who => ({ tier: "rama", branch, kind: "sandbox" });
const pr = (branch: string): Who => ({ tier: "rama", branch, kind: "ci" });
const main: Who = { tier: "main", branch: "main", kind: "ci" };

function fakeMetrics() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, binding: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => void points.push(point!) } };
}

function fakeAnalytics(rows: Record<string, unknown>[] = []) {
  const queries: string[] = [];
  const client: AnalyticsClient = {
    query: async (sql) => {
      queries.push(sql);
      return rows;
    },
  };
  return { queries, factory: () => client };
}

let n = 0;
const freshHash = () => `${Date.now().toString(16)}${(++n).toString(16).padStart(4, "0")}ff`;

describe("metrics recording", () => {
  const app = createApp({ jwks: createLocalJWKSet({ keys: [] }) });
  const metrics = fakeMetrics();
  const testEnv = { ...env, METRICS: metrics.binding };

  async function req(who: Who, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
    const all: Record<string, string> = { authorization: `Bearer ${await sessionToken(who)}`, ...headers };
    if (body !== undefined) all["content-length"] = String(body.length);
    return app.request(path, { method, headers: all, ...(body !== undefined ? { body } : {}) }, testEnv);
  }

  it("one data point per cache request with the fixed column order", async () => {
    const own = freshHash();
    const fromMain = freshHash();
    metrics.points.length = 0;

    await req(sandbox("feature/m"), "PUT", `/v8/artifacts/${own}`, "abcd", { "x-artifact-duration": "900" });
    await req(main, "PUT", `/v8/artifacts/${fromMain}`, "xy", { "x-artifact-duration": "300" });
    await req(pr("feature/m"), "GET", `/v8/artifacts/${own}`);
    await req(pr("feature/m"), "GET", `/v8/artifacts/${fromMain}`);
    await req(pr("feature/m"), "GET", `/v8/artifacts/${freshHash()}`);
    await req(pr("feature/m"), "HEAD", `/v8/artifacts/${own}`); // not counted
    await req(pr("feature/m"), "POST", "/v8/artifacts", JSON.stringify({ hashes: [own] })); // not counted

    const id = String(TEST_REPO_ID);
    expect(metrics.points).toEqual([
      { indexes: [id], blobs: [id, "rama", "sandbox", "turbo", "write", "sandbox", "feature/m", "acme/widgets"], doubles: [4, 900] },
      { indexes: [id], blobs: [id, "main", "ci", "turbo", "write", "ci", "main", "acme/widgets"], doubles: [2, 300] },
      { indexes: [id], blobs: [id, "rama", "ci", "turbo", "hit", "sandbox", "feature/m", "acme/widgets"], doubles: [4, 900] },
      { indexes: [id], blobs: [id, "rama", "ci", "turbo", "hit-main", "ci", "feature/m", "acme/widgets"], doubles: [2, 300] },
      { indexes: [id], blobs: [id, "rama", "ci", "turbo", "miss", "", "feature/m", "acme/widgets"], doubles: [0, 0] },
    ]);
  });

  it("sccache: counts objects but not .sccache_check", async () => {
    metrics.points.length = 0;
    const path = `1/2/3/${freshHash()}`;
    await req(sandbox("feature/m"), "PUT", "/dav/.sccache_check", "Hello, World!");
    await req(sandbox("feature/m"), "GET", "/dav/.sccache_check");
    await req(sandbox("feature/m"), "PUT", `/dav/${path}`, "obj");
    await req(pr("feature/m"), "GET", `/dav/${path}`);
    expect(metrics.points.map((p) => [p.blobs?.[3], p.blobs?.[4], p.blobs?.[5], p.doubles])).toEqual([
      ["sccache", "write", "sandbox", [3, 0]],
      ["sccache", "hit", "sandbox", [3, 0]],
    ]);
  });

  it("without the METRICS binding the cache keeps working", async () => {
    const res = await app.request("/v8/artifacts/status", { headers: { authorization: `Bearer ${await sessionToken(main)}` } }, {
      ...env,
      METRICS: undefined,
    });
    expect(res.status).toBe(200);
  });
});

describe("Analytics Engine SQL", () => {
  it("stats: groups by tier, kind, protocol and result with _sample_interval", () => {
    expect(statsSql("ci_cache", 4242, "7d")).toBe(
      [
        "SELECT blob2 AS tier, blob3 AS kind, blob4 AS protocol, blob5 AS result,",
        "  SUM(_sample_interval) AS requests,",
        "  SUM(_sample_interval * double1) AS bytes,",
        "  SUM(_sample_interval * double2) AS duration_ms",
        "FROM ci_cache",
        "WHERE index1 = '4242' AND timestamp > NOW() - INTERVAL '7' DAY",
        "GROUP BY tier, kind, protocol, result",
        "FORMAT JSON",
      ].join("\n"),
    );
    expect(statsSql("ci_cache", 1, "1h")).toContain("INTERVAL '1' HOUR");
    expect(statsSql("ci_cache", 1, "24h")).toContain("INTERVAL '24' HOUR");
    expect(statsSql("ci_cache", 1, "90d")).toContain("INTERVAL '90' DAY");
  });

  it("branches: only the rama (branch) tier, by branch, kind, result and writer-kind", () => {
    expect(branchesSql("ci_cache", 4242, "30d")).toBe(
      [
        "SELECT blob7 AS branch, blob3 AS kind, blob5 AS result, blob6 AS writer_kind,",
        "  SUM(_sample_interval) AS requests",
        "FROM ci_cache",
        "WHERE index1 = '4242' AND timestamp > NOW() - INTERVAL '30' DAY AND blob2 = 'rama'",
        "GROUP BY branch, kind, result, writer_kind",
        "ORDER BY branch",
        "LIMIT 10000",
        "FORMAT JSON",
      ].join("\n"),
    );
  });

  it("never interpolates an invalid repoId", () => {
    expect(() => statsSql("ci_cache", Number.NaN, "7d")).toThrow();
    expect(() => statsSql("ci_cache", -1, "7d")).toThrow();
    expect(() => branchesSql("ci_cache", 1.5, "7d")).toThrow();
  });
});

describe("response shape", () => {
  it("shapeStats sums by tier, kind and protocol (AE may return numbers as text)", () => {
    const stats = shapeStats([
      { tier: "rama", kind: "ci", protocol: "turbo", result: "hit", requests: "8", bytes: "800", duration_ms: "4000" },
      { tier: "rama", kind: "ci", protocol: "turbo", result: "hit-main", requests: 2, bytes: 200, duration_ms: 1000 },
      { tier: "rama", kind: "ci", protocol: "sccache", result: "miss", requests: 10, bytes: 0, duration_ms: 0 },
      { tier: "rama", kind: "sandbox", protocol: "sccache", result: "write", requests: 5, bytes: 5000, duration_ms: 0 },
      { tier: "main", kind: "ci", protocol: "turbo", result: "write", requests: 1, bytes: 100, duration_ms: 50 },
      { tier: "odd", kind: "odd", protocol: "odd", result: "hit", requests: 1, bytes: 1, duration_ms: 1 },
    ]);
    expect(stats.totals).toEqual({
      requests: 27, hits: 11, hitsFromMain: 2, misses: 10, writes: 6,
      bytesRead: 1001, bytesWritten: 5100, timeSavedMs: 5001, hitRate: 0.5238,
    });
    expect(stats.byTier.rama).toMatchObject({ hits: 10, misses: 10, writes: 5, hitRate: 0.5 });
    expect(stats.byTier.main).toMatchObject({ writes: 1, hitRate: null });
    expect(stats.byTier["main-ro"]).toMatchObject({ requests: 0, hitRate: null });
    expect(stats.byKind.sandbox).toMatchObject({ writes: 5, bytesWritten: 5000 });
    expect(stats.byProtocol.turbo).toMatchObject({ hits: 10, timeSavedMs: 5000, writes: 1 });
    expect(stats.byProtocol.sccache).toMatchObject({ misses: 10, writes: 5 });
  });

  it("shapeBranches flags reuseAlert when the sandbox wrote ≥ N and CI hit none of them", () => {
    const branches = shapeBranches(
      [
        { branch: "feature/ok", kind: "sandbox", result: "write", writer_kind: "sandbox", requests: 10 },
        { branch: "feature/ok", kind: "ci", result: "hit", writer_kind: "sandbox", requests: 7 },
        { branch: "feature/ok", kind: "ci", result: "miss", writer_kind: "", requests: 3 },
        { branch: "feature/bad", kind: "sandbox", result: "write", writer_kind: "sandbox", requests: "12" },
        { branch: "feature/bad", kind: "ci", result: "hit-main", writer_kind: "ci", requests: 4 },
        { branch: "feature/bad", kind: "ci", result: "miss", writer_kind: "", requests: 12 },
        { branch: "feature/few", kind: "sandbox", result: "write", writer_kind: "sandbox", requests: 2 },
      ],
      3,
    );
    expect(branches).toEqual([
      { branch: "feature/bad", sandboxWrites: 12, ciReads: 16, ciHits: 4, ciHitsOnSandboxObjects: 0, reuseAlert: true },
      { branch: "feature/ok", sandboxWrites: 10, ciReads: 10, ciHits: 7, ciHitsOnSandboxObjects: 7, reuseAlert: false },
      { branch: "feature/few", sandboxWrites: 2, ciReads: 0, ciHits: 0, ciHitsOnSandboxObjects: 0, reuseAlert: false },
    ]);
  });
});

describe("GET /v1/stats and /v1/stats/branches", () => {
  const rows = [{ tier: "rama", kind: "ci", protocol: "turbo", result: "hit", requests: 1, bytes: 10, duration_ms: 20 }];
  const analytics = fakeAnalytics(rows);
  const app = createApp({ jwks: createLocalJWKSet({ keys: [] }), analytics: analytics.factory });
  const get = (path: string, token?: string) =>
    app.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : {}, env);

  it("answers with the stats key", async () => {
    const res = await get(`/v1/stats?repo=${TEST_REPO_ID}&range=24h`, TEST_STATS_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ repoId: TEST_REPO_ID, range: "24h", totals: { hits: 1, timeSavedMs: 20 } });
    expect(analytics.queries.at(-1)).toContain(`index1 = '${TEST_REPO_ID}' AND timestamp > NOW() - INTERVAL '24' HOUR`);
    expect(analytics.queries.at(-1)).toContain("FROM ci_cache");
  });

  it("branches uses REUSE_ALERT_MIN_WRITES and the default 7d range", async () => {
    const res = await get(`/v1/stats/branches?repo=${TEST_REPO_ID}`, TEST_STATS_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ repoId: TEST_REPO_ID, range: "7d", reuseAlertMinWrites: 3, branches: [] });
    expect(analytics.queries.at(-1)).toContain("blob2 = 'rama'");
  });

  it("validates repo and range", async () => {
    for (const query of ["", "?repo=abc", "?repo=0", "?repo=1;DROP", "?repo=1&range=1y", "?repo=1&range=7d'--"]) {
      expect((await get(`/v1/stats${query}`, TEST_STATS_KEY)).status, query).toBe(400);
    }
  });

  it("a key limited to one repo can't see others", async () => {
    expect((await get(`/v1/stats?repo=${TEST_REPO_ID}`, TEST_STATS_KEY_4242)).status).toBe(200);
    expect((await get("/v1/stats?repo=999", TEST_STATS_KEY_4242)).status).toBe(403);
    expect((await get("/v1/stats/branches?repo=999", TEST_STATS_KEY_4242)).status).toBe(403);
  });

  it("keys don't cross over: no session or sandbox key on stats, no stats key on the cache", async () => {
    const session = await sessionToken(main);
    expect((await get(`/v1/stats?repo=${TEST_REPO_ID}`)).status).toBe(401);
    expect((await get(`/v1/stats?repo=${TEST_REPO_ID}`, session)).status).toBe(401);
    expect((await get(`/v1/stats?repo=${TEST_REPO_ID}`, TEST_SANDBOX_KEY)).status).toBe(401);
    expect((await get(`/v1/stats/branches?repo=${TEST_REPO_ID}`, session)).status).toBe(401);
    expect((await get("/v8/artifacts/status", TEST_STATS_KEY)).status).toBe(401);
    expect((await get("/dav/.sccache_check", TEST_STATS_KEY)).status).toBe(401);
    const asSession = await app.request("/v1/session", { method: "POST", headers: { authorization: `Bearer ${TEST_STATS_KEY}` } }, env);
    expect(asSession.status).toBe(401);
  });

  it("without CF_ACCOUNT_ID/CF_API_TOKEN → 503 with no details", async () => {
    const real = createApp({ jwks: createLocalJWKSet({ keys: [] }) });
    const res = await real.request(`/v1/stats?repo=${TEST_REPO_ID}`, { headers: { authorization: `Bearer ${TEST_STATS_KEY}` } }, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "metrics_not_configured", message: "Metrics are not configured" });
  });
});

describe("SQL API client", () => {
  it("sends the SQL to the account with the token and returns data", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ meta: [], data: [{ requests: "3" }], rows: 1 });
    }) as unknown as typeof fetch;
    const client = cloudflareAnalytics("0123456789abcdef0123456789abcdef", "tok", fetcher);
    expect(await client.query("SELECT 1")).toEqual([{ requests: "3" }]);
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/analytics_engine/sql");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer tok");
    expect(calls[0]?.init.body).toBe("SELECT 1");
  });

  it("API errors → generic 502", async () => {
    const failing = (async () => new Response("internal detail", { status: 500 })) as unknown as typeof fetch;
    await expect(cloudflareAnalytics("0".repeat(32), "t", failing).query("x")).rejects.toMatchObject({ status: 502 });
    const garbage = (async () => Response.json({ nope: true })) as unknown as typeof fetch;
    await expect(cloudflareAnalytics("0".repeat(32), "t", garbage).query("x")).rejects.toMatchObject({ status: 502 });
    const offline = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    await expect(cloudflareAnalytics("0".repeat(32), "t", offline).query("x")).rejects.toMatchObject({ status: 502 });
  });
});
