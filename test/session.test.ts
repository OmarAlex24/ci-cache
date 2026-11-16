import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { HttpError } from "../src/errors.ts";
import { requireSession } from "../src/session/middleware.ts";
import { resolveTier } from "../src/session/policy.ts";
import { verifySession } from "../src/session/token.ts";
import type { AppEnv } from "../src/types.ts";
import { TEST_REPO_ID, TEST_SANDBOX_KEY } from "./bindings.ts";
import { githubClaims, oidcFixture, postSession, sessionToken, signOidc } from "./helpers.ts";

let app: ReturnType<typeof createApp>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const fixture = await oidcFixture();
  privateKey = fixture.privateKey;
  app = createApp({ jwks: fixture.jwks });
});

interface SessionBody {
  token: string;
  tier: string;
  branch: string;
  kind: string;
  repoId: number;
  repo: string;
  expiresAt: string;
}

async function sessionWithOidc(claims = githubClaims(), options = {}) {
  return postSession(app, `Bearer ${await signOidc(privateKey, claims, options)}`);
}

describe("GET /health", () => {
  it("answers without a token", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/session with GitHub OIDC", () => {
  it("push to main → main tier", async () => {
    const res = await sessionWithOidc();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<SessionBody>();
    expect(body).toMatchObject({ tier: "main", branch: "main", kind: "ci", repoId: TEST_REPO_ID, repo: "acme/widgets" });
    const claims = await verifySession(body.token, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
    expect(claims).toMatchObject({ v: 1, tier: "main", kind: "ci", repoId: TEST_REPO_ID });
    // Default TTL: 6 h.
    expect(claims!.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(6 * 3600 - 10);
  });

  it("push to master is also main", async () => {
    const body = await (await sessionWithOidc(githubClaims({ ref: "refs/heads/master" }))).json<SessionBody>();
    expect(body.tier).toBe("main");
  });

  it("schedule on main → main-ro", async () => {
    const res = await sessionWithOidc(githubClaims({ event_name: "schedule" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: "main-ro", branch: "main" });
  });

  it("workflow_dispatch on main → main-ro", async () => {
    const body = await (await sessionWithOidc(githubClaims({ event_name: "workflow_dispatch" }))).json<SessionBody>();
    expect(body.tier).toBe("main-ro");
  });

  it("pull_request → rama (branch tier) with head_ref", async () => {
    const res = await sessionWithOidc(
      githubClaims({ event_name: "pull_request", ref: "refs/pull/7/merge", head_ref: "feature/login" }),
    );
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/login", kind: "ci" });
  });

  it("pull_request_target (ref = main) → rama with head_ref, never main-ro or main", async () => {
    const res = await sessionWithOidc(
      githubClaims({ event_name: "pull_request_target", ref: "refs/heads/main", head_ref: "feature/login" }),
    );
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/login" });
  });

  it("push to another branch → rama with the ref's name", async () => {
    const res = await sessionWithOidc(githubClaims({ ref: "refs/heads/feature/x" }));
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/x" });
  });

  it("the body cannot pick the tier or the branch", async () => {
    const token = await signOidc(privateKey, githubClaims({ event_name: "pull_request", ref: "refs/pull/1/merge", head_ref: "x" }));
    const res = await postSession(app, `Bearer ${token}`, { branch: "main", tier: "main" });
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "x" });
  });

  it("allowed owner regardless of case", async () => {
    const res = await sessionWithOidc(githubClaims({ repository_owner: "other-org", repository: "other-org/x" }));
    expect(res.status).toBe(200);
  });

  it("rejects a bad signature (another key with the same kid)", async () => {
    const other = await generateKeyPair("RS256");
    const token = await signOidc(other.privateKey, githubClaims());
    const res = await postSession(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthorized", message: "Missing or invalid token" });
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await signOidc(privateKey, githubClaims());
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await postSession(app, `Bearer ${tampered}`)).status).toBe(401);
  });

  it("rejects a bad aud", async () => {
    expect((await sessionWithOidc(githubClaims(), { aud: "other-audience" })).status).toBe(401);
  });

  it("rejects a bad iss", async () => {
    expect((await sessionWithOidc(githubClaims(), { iss: "https://evil.example" })).status).toBe(401);
  });

  it("rejects an expired token (beyond the tolerance)", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await sessionWithOidc(githubClaims(), { expSeconds: now - 120 })).status).toBe(401);
  });

  it("rejects nbf in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await sessionWithOidc(githubClaims(), { nbfSeconds: now + 300 })).status).toBe(401);
  });

  it("rejects a disallowed owner with 403", async () => {
    const res = await sessionWithOidc(githubClaims({ repository_owner: "intruder", repository: "intruder/x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
  });

  it("rejects a non-numeric repository_id", async () => {
    expect((await sessionWithOidc(githubClaims({ repository_id: "abc" }))).status).toBe(401);
  });

  it("rejects a missing Authorization or a non-Bearer scheme", async () => {
    expect((await postSession(app)).status).toBe(401);
    expect((await postSession(app, "Basic abc")).status).toBe(401);
  });

  it("rejects our own session token as a /v1/session credential", async () => {
    expect((await postSession(app, `Bearer ${await sessionToken()}`)).status).toBe(401);
  });
});

describe("POST /v1/session with a sandbox key", () => {
  it("gets the rama (branch) tier", async () => {
    const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch: "feature/x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/x", kind: "sandbox", repoId: TEST_REPO_ID });
  });

  it("branch named main → still the rama tier", async () => {
    const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch: "main" });
    const body = await res.json<SessionBody>();
    expect(body).toMatchObject({ tier: "rama", branch: "main", kind: "sandbox" });
    const claims = await verifySession(body.token, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
    expect(claims?.tier).toBe("rama");
  });

  it("rejects an unknown key", async () => {
    expect((await postSession(app, "Bearer sk_unknown", { branch: "x" })).status).toBe(401);
  });

  it("validates the branch", async () => {
    for (const branch of ["", "a b", "../x", "x..y", "/x", "x/", "a\u0000b", "x".repeat(256), 3]) {
      const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch });
      expect(res.status, JSON.stringify(branch)).toBe(400);
    }
    expect((await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`)).status).toBe(400);
  });

  it("rejects large bodies", async () => {
    const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch: "x", pad: "y".repeat(5000) });
    expect(res.status).toBe(413);
  });
});

describe("session token and middleware", () => {
  const guarded = new Hono<AppEnv>();
  guarded.onError((error, c) =>
    error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({}, 500),
  );
  guarded.get("/x", requireSession, (c) => c.json(c.get("session")));

  it("accepts a valid token and exposes its claims", async () => {
    const res = await guarded.request("/x", { headers: { authorization: `Bearer ${await sessionToken()}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/x" });
  });

  it("rejects a tampered or expired token, one signed with another secret, or a sandbox key", async () => {
    const valid = await sessionToken();
    const [payload, sig] = valid.split(".") as [string, string];
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))), tier: "main" }))
      .replaceAll("=", "")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    const expired = await sessionToken({ exp: Math.floor(Date.now() / 1000) - 1 });
    const { signSession } = await import("../src/session/token.ts");
    const otherSecret = await signSession(
      { v: 1, repoId: 1, repo: "a/b", tier: "main", branch: "main", kind: "ci", exp: Math.floor(Date.now() / 1000) + 60 },
      "another-secret-at-least-32-characters-xx",
    );
    for (const token of [`${forged}.${sig}`, expired, otherSecret, TEST_SANDBOX_KEY, "a.b", "x"]) {
      const res = await guarded.request("/x", { headers: { authorization: `Bearer ${token}` } }, env);
      expect(res.status, token.slice(0, 12)).toBe(401);
    }
    expect((await guarded.request("/x", {}, env)).status).toBe(401);
  });
});

describe("resolveTier", () => {
  const policy = { mainWriteEvents: new Set(["push"]), mainRefs: new Set(["refs/heads/main"]) };
  it("honors configurable MAIN_WRITE_EVENTS", () => {
    const custom = { ...policy, mainWriteEvents: new Set(["push", "merge_group"]) };
    expect(resolveTier({ event_name: "merge_group", ref: "refs/heads/main" }, custom).tier).toBe("main");
    expect(resolveTier({ event_name: "merge_group", ref: "refs/heads/main" }, policy).tier).toBe("main-ro");
  });
  it("tags and other refs → rama with the full ref", () => {
    expect(resolveTier({ event_name: "push", ref: "refs/tags/v1" }, policy)).toEqual({ tier: "rama", branch: "refs/tags/v1" });
  });
});
