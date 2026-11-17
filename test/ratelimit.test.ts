import { env } from "cloudflare:workers";
import type { JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import type { FailureLimiter } from "../src/ratelimit.ts";
import type { AnalyticsClient } from "../src/stats/analytics.ts";
import { TEST_REPO_ID, TEST_SANDBOX_KEY, TEST_STATS_KEY } from "./bindings.ts";
import { githubClaims, oidcFixture, sessionToken, signOidc } from "./helpers.ts";

const LIMIT = 3;

/** In-memory stand-in for the Workers Rate Limiting binding: LIMIT successes per key. */
function fakeLimiter(limit = LIMIT) {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const limiter: FailureLimiter = {
    limit: async ({ key }) => {
      calls.push(key);
      const used = counts.get(key) ?? 0;
      if (used >= limit) return { success: false };
      counts.set(key, used + 1);
      return { success: true };
    },
  };
  return { limiter, calls };
}

function fakeAnalytics() {
  let queries = 0;
  const client: AnalyticsClient = {
    query: async () => {
      queries++;
      return [];
    },
  };
  return { factory: () => client, count: () => queries };
}

let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;
beforeAll(async () => {
  ({ privateKey, jwks } = await oidcFixture());
});

function setup(limit = LIMIT) {
  const fake = fakeLimiter(limit);
  const analytics = fakeAnalytics();
  let jwksCalls = 0;
  const countingJwks: JWTVerifyGetKey = (...args) => {
    jwksCalls++;
    return jwks(...args);
  };
  const app = createApp({ jwks: countingJwks, rateLimiter: () => fake.limiter, analytics: analytics.factory });
  const request = (path: string, init: { ip?: string; auth?: string; method?: string; body?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (init.ip) headers["cf-connecting-ip"] = init.ip;
    if (init.auth) headers.authorization = init.auth;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return app.request(
      path,
      { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: init.body } : {}) },
      env,
    );
  };
  return { request, calls: fake.calls, jwksCalls: () => jwksCalls, analyticsQueries: analytics.count };
}

describe("rate limit on requests without a valid credential", () => {
  it("N bad requests from one IP get 429 with generic JSON; another IP still gets 401", async () => {
    const { request } = setup();
    for (let i = 0; i < LIMIT; i++) {
      expect((await request("/v8/artifacts/status", { ip: "203.0.113.1", auth: "Bearer nope" })).status).toBe(401);
    }
    const limited = await request("/v8/artifacts/status", { ip: "203.0.113.1", auth: "Bearer nope" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    const body = await limited.json<Record<string, unknown>>();
    expect(body).toMatchObject({ code: "rate_limited", message: "Too many requests" });
    expect(JSON.stringify(body)).not.toContain("203.0.113.1");
    expect((await request("/v8/artifacts/status", { ip: "198.51.100.7", auth: "Bearer nope" })).status).toBe(401);
  });

  it("a valid token is never limited, even from an IP that is over the limit", async () => {
    const { request, calls } = setup();
    const ip = "203.0.113.2";
    for (let i = 0; i <= LIMIT; i++) await request("/dav/.sccache_check", { ip });
    expect((await request("/dav/.sccache_check", { ip })).status).toBe(429);
    const before = calls.length;
    const token = await sessionToken();
    for (let i = 0; i < LIMIT * 3; i++) {
      expect((await request("/v8/artifacts/status", { ip, auth: `Bearer ${token}` })).status).toBe(200);
    }
    const stats = await request(`/v1/stats?repo=${TEST_REPO_ID}`, { ip, auth: `Bearer ${TEST_STATS_KEY}` });
    expect(stats.status).toBe(200);
    const oidc = await signOidc(privateKey, githubClaims());
    expect((await request("/v1/session", { ip, auth: `Bearer ${oidc}`, method: "POST" })).status).toBe(200);
    const sandbox = await request("/v1/session", {
      ip,
      auth: `Bearer ${TEST_SANDBOX_KEY}`,
      method: "POST",
      body: JSON.stringify({ branch: "feature/x" }),
    });
    expect(sandbox.status).toBe(200);
    // Valid credentials never consult the limiter.
    expect(calls.length).toBe(before);
  });

  it("counts failed POST /v1/session (missing Bearer, bad sk_, bad OIDC, disallowed owner)", async () => {
    const { request, calls } = setup(100);
    const ip = "203.0.113.3";
    await request("/v1/session", { ip, method: "POST" });
    await request("/v1/session", { ip, method: "POST", auth: "Bearer sk_bad", body: JSON.stringify({ branch: "x" }) });
    const forged = await signOidc((await oidcFixture()).privateKey, githubClaims());
    expect((await request("/v1/session", { ip, method: "POST", auth: `Bearer ${forged}` })).status).toBe(401);
    const otherOwner = await signOidc(privateKey, githubClaims({ repository_owner: "evil" }));
    expect((await request("/v1/session", { ip, method: "POST", auth: `Bearer ${otherOwner}` })).status).toBe(403);
    expect(calls).toEqual(Array(4).fill(`bad-credential:${ip}`));
  });

  it("does not count 400s (a bad branch is not a bad credential)", async () => {
    const { request, calls } = setup();
    const res = await request("/v1/session", {
      ip: "203.0.113.4",
      method: "POST",
      auth: `Bearer ${TEST_SANDBOX_KEY}`,
      body: JSON.stringify({ branch: "has space" }),
    });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects malformed or mis-addressed JWTs before the JWKS lookup", async () => {
    const { request, jwksCalls } = setup(100);
    const ip = "203.0.113.5";
    const wrongAud = await signOidc(privateKey, githubClaims(), { aud: "someone-else" });
    const wrongIss = await signOidc(privateKey, githubClaims(), { iss: "https://example.com" });
    const expired = await signOidc(privateKey, githubClaims(), { expSeconds: Math.floor(Date.now() / 1000) - 600 });
    for (const credential of ["not.a.jwt", "aaaa.bbbb.cccc", wrongAud, wrongIss, expired]) {
      expect((await request("/v1/session", { ip, method: "POST", auth: `Bearer ${credential}` })).status).toBe(401);
    }
    expect(jwksCalls()).toBe(0);
    const valid = await signOidc(privateKey, githubClaims());
    expect((await request("/v1/session", { ip, method: "POST", auth: `Bearer ${valid}` })).status).toBe(200);
    expect(jwksCalls()).toBe(1);
  });

  it("an over-limit IP gets 429 on /v1/stats without querying Analytics Engine", async () => {
    const { request, analyticsQueries } = setup();
    const ip = "203.0.113.6";
    for (let i = 0; i < LIMIT; i++) {
      expect((await request(`/v1/stats?repo=${TEST_REPO_ID}`, { ip, auth: "Bearer rk_bad" })).status).toBe(401);
    }
    expect((await request(`/v1/stats?repo=${TEST_REPO_ID}`, { ip, auth: "Bearer rk_bad" })).status).toBe(429);
    expect(analyticsQueries()).toBe(0);
  });

  it("fails open: no client IP, a limiter error or the switch off never block", async () => {
    const { request, calls } = setup(0);
    expect((await request("/v8/artifacts/status", { auth: "Bearer nope" })).status).toBe(401);
    expect(calls).toEqual([]);

    const broken = createApp({
      jwks,
      rateLimiter: () => ({ limit: () => Promise.reject(new Error("down")) }),
    });
    const res = await broken.request("/v8/artifacts/status", { headers: { "cf-connecting-ip": "203.0.113.7" } }, env);
    expect(res.status).toBe(401);

    const off = createApp({ jwks });
    const offEnv = { ...env, RATE_LIMIT_BAD_CREDENTIALS: "false", BAD_CREDENTIAL_LIMITER: fakeLimiter(0).limiter };
    const offRes = await off.request("/v8/artifacts/status", { headers: { "cf-connecting-ip": "203.0.113.8" } }, offEnv);
    expect(offRes.status).toBe(401);
  });

  it("uses the BAD_CREDENTIAL_LIMITER binding from wrangler.jsonc by default", async () => {
    const app = createApp({ jwks });
    const ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`;
    const statuses: number[] = [];
    // wrangler.jsonc: 30 failures per 60 s.
    for (let i = 0; i < 31; i++) {
      const res = await app.request("/v8/artifacts/status", { headers: { "cf-connecting-ip": ip } }, env);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
