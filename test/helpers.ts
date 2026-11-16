import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

import { createApp } from "../src/app.ts";
import { GITHUB_OIDC_ISSUER } from "../src/session/oidc.ts";
import { signSession, type SessionClaims } from "../src/session/token.ts";
import { TEST_AUDIENCE, TEST_REPO_ID } from "./bindings.ts";

export const KID = "test-kid";

export async function oidcFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey, jwks };
}

/** Default GitHub Actions claims: a push to main of acme/widgets. */
export function githubClaims(overrides: JWTPayload = {}): JWTPayload {
  return {
    repository: "acme/widgets",
    repository_id: String(TEST_REPO_ID),
    repository_owner: "acme",
    event_name: "push",
    ref: "refs/heads/main",
    head_ref: "",
    ...overrides,
  };
}

export async function signOidc(
  key: CryptoKey,
  claims: JWTPayload,
  options: { iss?: string; aud?: string; expSeconds?: number; nbfSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(options.iss ?? GITHUB_OIDC_ISSUER)
    .setAudience(options.aud ?? TEST_AUDIENCE)
    .setIssuedAt(now - 10)
    .setNotBefore(options.nbfSeconds ?? now - 10)
    .setExpirationTime(options.expSeconds ?? now + 300)
    .sign(key);
}

export function postSession(app: ReturnType<typeof createApp>, authorization?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(
    "/v1/session",
    { method: "POST", headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    env,
  );
}

export function sessionToken(overrides: Partial<SessionClaims> = {}): Promise<string> {
  return signSession(
    {
      v: 1,
      repoId: TEST_REPO_ID,
      repo: "acme/widgets",
      tier: "rama",
      branch: "feature/x",
      kind: "sandbox",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    },
    env.SESSION_SECRET,
  );
}
