import { env } from "cloudflare:workers";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import type { AnalyticsClient } from "../src/stats/analytics.ts";
import { repoBranchesSql, reposSql, shapeRepos, toIso } from "../src/stats/repos.ts";
import { TEST_REPO_ID, TEST_SANDBOX_KEY, TEST_STATS_KEY, TEST_STATS_KEY_4242 } from "./bindings.ts";
import { sessionToken } from "./helpers.ts";

describe("/v1/stats/repos SQL", () => {
  it("totals by repo, name and result, with the latest request", () => {
    expect(reposSql("ci_cache", "7d")).toBe(
      [
        "SELECT blob1 AS repo_id, blob8 AS repo, blob5 AS result,",
        "  SUM(_sample_interval) AS requests,",
        "  SUM(_sample_interval * double1) AS bytes,",
        "  SUM(_sample_interval * double2) AS duration_ms,",
        "  MAX(timestamp) AS last_seen",
        "FROM ci_cache",
        "WHERE timestamp > NOW() - INTERVAL '7' DAY",
        "GROUP BY repo_id, repo, result",
        "LIMIT 10000",
        "FORMAT JSON",
      ].join("\n"),
    );
  });

  it("branches of every repo, rama (branch) tier only", () => {
    expect(repoBranchesSql("ci_cache", "24h")).toBe(
      [
        "SELECT blob1 AS repo_id, blob7 AS branch, blob3 AS kind, blob5 AS result, blob6 AS writer_kind,",
        "  SUM(_sample_interval) AS requests",
        "FROM ci_cache",
        "WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob2 = 'rama'",
        "GROUP BY repo_id, branch, kind, result, writer_kind",
        "LIMIT 10000",
        "FORMAT JSON",
      ].join("\n"),
    );
  });

  it("a limited key filters by its repos; an empty list sees nothing", () => {
    expect(reposSql("ci_cache", "7d", [4242, 7])).toContain(
      "WHERE timestamp > NOW() - INTERVAL '7' DAY AND (index1 = '4242' OR index1 = '7')",
    );
    expect(repoBranchesSql("ci_cache", "7d", [4242])).toContain("AND (index1 = '4242') AND blob2 = 'rama'");
    expect(reposSql("ci_cache", "7d", [])).toContain("AND 1 = 0");
    expect(() => reposSql("ci_cache", "7d", [1.5])).toThrow();
    expect(() => repoBranchesSql("ci_cache", "7d", [-1])).toThrow();
  });
});

describe("/v1/stats/repos shape", () => {
  const known = new Map([[7, "acme/old"]]);

  it("sums by repo, takes the most recent name and counts the reuseAlerts", () => {
    const repos = shapeRepos(
      [
        { repo_id: "4242", repo: "", result: "hit", requests: "6", bytes: "600", duration_ms: "3000", last_seen: "2026-11-14 10:00:00" },
        { repo_id: "4242", repo: "acme/widgets", result: "miss", requests: 4, bytes: 0, duration_ms: 0, last_seen: "2026-11-15 09:30:00" },
        { repo_id: "4242", repo: "acme/gadgets", result: "write", requests: 2, bytes: 50, duration_ms: 0, last_seen: "2026-11-13 08:00:00" },
        { repo_id: "7", repo: "", result: "write", requests: 25, bytes: 2500, duration_ms: 0, last_seen: "2026-11-12 00:00:00" },
        { repo_id: "99", repo: "", result: "miss", requests: 1, bytes: 0, duration_ms: 0, last_seen: "garbage" },
        { repo_id: "x", repo: "", result: "hit", requests: 1, bytes: 1, duration_ms: 1, last_seen: "2026-11-15 00:00:00" },
      ],
      [
        { repo_id: "7", branch: "feature/bad", kind: "sandbox", result: "write", writer_kind: "sandbox", requests: 25 },
        { repo_id: "7", branch: "feature/bad", kind: "ci", result: "miss", writer_kind: "", requests: 25 },
        { repo_id: "4242", branch: "feature/ok", kind: "sandbox", result: "write", writer_kind: "sandbox", requests: 2 },
      ],
      { minWrites: 20, knownNames: known },
    );
    expect(repos).toEqual([
      {
        repoId: 4242,
        repo: "acme/widgets",
        lastSeenAt: "2026-11-15T09:30:00.000Z",
        totals: {
          requests: 12, hits: 6, hitsFromMain: 0, misses: 4, writes: 2,
          bytesRead: 600, bytesWritten: 50, timeSavedMs: 3000, hitRate: 0.6,
        },
        reuseAlerts: 0,
      },
      expect.objectContaining({ repoId: 7, repo: "acme/old", lastSeenAt: "2026-11-12T00:00:00.000Z", reuseAlerts: 1 }),
      expect.objectContaining({ repoId: 99, repo: null, lastSeenAt: null, reuseAlerts: 0 }),
    ]);
  });

  it("toIso understands the AE format, ISO and Unix seconds", () => {
    expect(toIso("2026-11-15 12:34:56")).toBe("2026-11-15T12:34:56.000Z");
    expect(toIso("2026-11-15T12:34:56Z")).toBe("2026-11-15T12:34:56.000Z");
    expect(toIso(1_763_200_000)).toBe(new Date(1_763_200_000_000).toISOString());
    expect(toIso("")).toBeNull();
    expect(toIso(null)).toBeNull();
  });
});

describe("GET /v1/stats/repos", () => {
  const queries: string[] = [];
  const client: AnalyticsClient = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes("writer_kind")) return [];
      return [{ repo_id: String(TEST_REPO_ID), repo: "", result: "hit", requests: 1, bytes: 10, duration_ms: 20, last_seen: "2026-11-15 01:02:03" }];
    },
  };
  const app = createApp({ jwks: createLocalJWKSet({ keys: [] }), analytics: () => client });
  const get = (path: string, token?: string) =>
    app.request(path, token ? { headers: { authorization: `Bearer ${token}` } } : {}, env);

  it("lists the repos with traffic; the name comes from SANDBOX_KEYS if the data point lacks it", async () => {
    queries.length = 0;
    const res = await get("/v1/stats/repos?range=24h", TEST_STATS_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      range: "24h",
      reuseAlertMinWrites: 3,
      repos: [{ repoId: TEST_REPO_ID, repo: "acme/widgets", lastSeenAt: "2026-11-15T01:02:03.000Z", reuseAlerts: 0, totals: { hits: 1, hitRate: 1 } }],
    });
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => !sql.includes("index1 ="))).toBe(true);
  });

  it("default range 7d and validates the range", async () => {
    expect(await (await get("/v1/stats/repos", TEST_STATS_KEY)).json()).toMatchObject({ range: "7d" });
    expect((await get("/v1/stats/repos?range=1y", TEST_STATS_KEY)).status).toBe(400);
  });

  it("a limited key only queries its repos", async () => {
    queries.length = 0;
    expect((await get("/v1/stats/repos", TEST_STATS_KEY_4242)).status).toBe(200);
    expect(queries.every((sql) => sql.includes(`AND (index1 = '${TEST_REPO_ID}')`))).toBe(true);
  });

  it("only with an rk_ key", async () => {
    expect((await get("/v1/stats/repos")).status).toBe(401);
    expect((await get("/v1/stats/repos", TEST_SANDBOX_KEY)).status).toBe(401);
    expect((await get("/v1/stats/repos", await sessionToken())).status).toBe(401);
  });
});
