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
  it("responde sin token", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /v1/session con OIDC de GitHub", () => {
  it("push a main → nivel main", async () => {
    const res = await sessionWithOidc();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<SessionBody>();
    expect(body).toMatchObject({ tier: "main", branch: "main", kind: "ci", repoId: TEST_REPO_ID, repo: "acme/widgets" });
    const claims = await verifySession(body.token, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
    expect(claims).toMatchObject({ v: 1, tier: "main", kind: "ci", repoId: TEST_REPO_ID });
    // TTL por defecto: 6 h.
    expect(claims!.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(6 * 3600 - 10);
  });

  it("push a master también es main", async () => {
    const body = await (await sessionWithOidc(githubClaims({ ref: "refs/heads/master" }))).json<SessionBody>();
    expect(body.tier).toBe("main");
  });

  it("schedule sobre main → main-ro", async () => {
    const res = await sessionWithOidc(githubClaims({ event_name: "schedule" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: "main-ro", branch: "main" });
  });

  it("workflow_dispatch sobre main → main-ro", async () => {
    const body = await (await sessionWithOidc(githubClaims({ event_name: "workflow_dispatch" }))).json<SessionBody>();
    expect(body.tier).toBe("main-ro");
  });

  it("pull_request → rama con head_ref", async () => {
    const res = await sessionWithOidc(
      githubClaims({ event_name: "pull_request", ref: "refs/pull/7/merge", head_ref: "feature/login" }),
    );
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/login", kind: "ci" });
  });

  it("pull_request_target (ref = main) → rama con head_ref, nunca main-ro ni main", async () => {
    const res = await sessionWithOidc(
      githubClaims({ event_name: "pull_request_target", ref: "refs/heads/main", head_ref: "feature/login" }),
    );
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/login" });
  });

  it("push a otra rama → rama con el nombre de la ref", async () => {
    const res = await sessionWithOidc(githubClaims({ ref: "refs/heads/feature/x" }));
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/x" });
  });

  it("el cuerpo no puede elegir el nivel ni la rama", async () => {
    const token = await signOidc(privateKey, githubClaims({ event_name: "pull_request", ref: "refs/pull/1/merge", head_ref: "x" }));
    const res = await postSession(app, `Bearer ${token}`, { branch: "main", tier: "main" });
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "x" });
  });

  it("owner permitido sin importar mayúsculas", async () => {
    const res = await sessionWithOidc(githubClaims({ repository_owner: "other-org", repository: "other-org/x" }));
    expect(res.status).toBe(200);
  });

  it("rechaza firma mala (otra llave con el mismo kid)", async () => {
    const other = await generateKeyPair("RS256");
    const token = await signOidc(other.privateKey, githubClaims());
    const res = await postSession(app, `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthorized", message: "Token ausente o inválido" });
  });

  it("rechaza token con la firma alterada", async () => {
    const token = await signOidc(privateKey, githubClaims());
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await postSession(app, `Bearer ${tampered}`)).status).toBe(401);
  });

  it("rechaza aud mala", async () => {
    expect((await sessionWithOidc(githubClaims(), { aud: "otra-audiencia" })).status).toBe(401);
  });

  it("rechaza iss malo", async () => {
    expect((await sessionWithOidc(githubClaims(), { iss: "https://evil.example" })).status).toBe(401);
  });

  it("rechaza token expirado (más allá del margen)", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await sessionWithOidc(githubClaims(), { expSeconds: now - 120 })).status).toBe(401);
  });

  it("rechaza nbf en el futuro", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await sessionWithOidc(githubClaims(), { nbfSeconds: now + 300 })).status).toBe(401);
  });

  it("rechaza owner no permitido con 403", async () => {
    const res = await sessionWithOidc(githubClaims({ repository_owner: "intruso", repository: "intruso/x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden" });
  });

  it("rechaza repository_id no numérico", async () => {
    expect((await sessionWithOidc(githubClaims({ repository_id: "abc" }))).status).toBe(401);
  });

  it("rechaza sin Authorization o con esquema no Bearer", async () => {
    expect((await postSession(app)).status).toBe(401);
    expect((await postSession(app, "Basic abc")).status).toBe(401);
  });

  it("rechaza un token de sesión propio como credencial de /v1/session", async () => {
    expect((await postSession(app, `Bearer ${await sessionToken()}`)).status).toBe(401);
  });
});

describe("POST /v1/session con llave de sandbox", () => {
  it("da nivel rama", async () => {
    const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch: "feature/x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/x", kind: "sandbox", repoId: TEST_REPO_ID });
  });

  it("rama llamada main → sigue siendo nivel rama", async () => {
    const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch: "main" });
    const body = await res.json<SessionBody>();
    expect(body).toMatchObject({ tier: "rama", branch: "main", kind: "sandbox" });
    const claims = await verifySession(body.token, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
    expect(claims?.tier).toBe("rama");
  });

  it("rechaza llave desconocida", async () => {
    expect((await postSession(app, "Bearer sk_desconocida", { branch: "x" })).status).toBe(401);
  });

  it("valida la rama", async () => {
    for (const branch of ["", "a b", "../x", "x..y", "/x", "x/", "a\u0000b", "x".repeat(256), 3]) {
      const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch });
      expect(res.status, JSON.stringify(branch)).toBe(400);
    }
    expect((await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`)).status).toBe(400);
  });

  it("rechaza cuerpos grandes", async () => {
    const res = await postSession(app, `Bearer ${TEST_SANDBOX_KEY}`, { branch: "x", pad: "y".repeat(5000) });
    expect(res.status).toBe(413);
  });
});

describe("token de sesión y middleware", () => {
  const guarded = new Hono<AppEnv>();
  guarded.onError((error, c) =>
    error instanceof HttpError ? c.json({ code: error.code }, error.status) : c.json({}, 500),
  );
  guarded.get("/x", requireSession, (c) => c.json(c.get("session")));

  it("acepta un token válido y expone sus claims", async () => {
    const res = await guarded.request("/x", { headers: { authorization: `Bearer ${await sessionToken()}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier: "rama", branch: "feature/x" });
  });

  it("rechaza token alterado, expirado, firmado con otro secret o una llave de sandbox", async () => {
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
      "otro-secret-de-al-menos-32-caracteres-xx",
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
  it("respeta MAIN_WRITE_EVENTS configurables", () => {
    const custom = { ...policy, mainWriteEvents: new Set(["push", "merge_group"]) };
    expect(resolveTier({ event_name: "merge_group", ref: "refs/heads/main" }, custom).tier).toBe("main");
    expect(resolveTier({ event_name: "merge_group", ref: "refs/heads/main" }, policy).tier).toBe("main-ro");
  });
  it("tags y otras refs → rama con la ref completa", () => {
    expect(resolveTier({ event_name: "push", ref: "refs/tags/v1" }, policy)).toEqual({ tier: "rama", branch: "refs/tags/v1" });
  });
});
