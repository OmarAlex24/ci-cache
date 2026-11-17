import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";

import { readConfig, readSessionSecret } from "../config.ts";
import { badRequest, unauthorized } from "../errors.ts";
import { readBearer, readSmallJson } from "../http.ts";
import { countingFailures, rejectCredential } from "../ratelimit.ts";
import type { AppEnv } from "../types.ts";
import { findSandboxKey } from "./keys.ts";
import { verifyGithubOidc } from "./oidc.ts";
import { signSession, type SessionClaims } from "./token.ts";

export const SANDBOX_KEY_PREFIX = "sk_";

// Git-style branch name: no spaces or control characters, no `~^:?*[\`, no `..`,
// no leading or trailing `/`. It is only used hashed in R2 keys.
// oxlint-disable-next-line no-control-regex -- excluding control characters is exactly the intent
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[^\x00-\x20\x7f~^:?*[\\]{1,255}$/u;

function readBranch(body: unknown): string {
  if (typeof body !== "object" || body === null) throw badRequest("Missing branch field");
  const branch = (body as Record<string, unknown>).branch;
  if (typeof branch !== "string" || !BRANCH.test(branch)) throw badRequest("invalid branch");
  return branch;
}

export function sessionRoutes(deps: { jwks: JWTVerifyGetKey }) {
  const app = new Hono<AppEnv>();

  app.post("/v1/session", async (c) => {
    const credential = readBearer(c);
    if (!credential) return rejectCredential(c, unauthorized());
    const config = readConfig(c.env);
    const secret = readSessionSecret(c.env);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + config.sessionTtlSeconds;

    let claims: SessionClaims;
    if (credential.startsWith(SANDBOX_KEY_PREFIX)) {
      const branch = readBranch(await readSmallJson(c, 4096));
      const entry = await findSandboxKey(c.env.SANDBOX_KEYS, credential);
      if (!entry) return rejectCredential(c, unauthorized());
      // A sandbox key always gets the branch tier (`rama`), even if the branch is named main.
      claims = { v: 1, repoId: entry.repoId, repo: entry.repo, tier: "rama", branch, kind: "sandbox", exp };
    } else {
      // A 401 (bad token) or 403 (owner not allowed) counts against the client IP's limit.
      // verifyGithubOidc rejects malformed or mis-addressed JWTs before fetching the JWKS.
      const identity = await countingFailures(c, () => verifyGithubOidc(credential, config, deps.jwks));
      claims = { v: 1, ...identity, kind: "ci", exp };
    }

    c.header("cache-control", "no-store");
    return c.json({
      token: await signSession(claims, secret),
      expiresAt: new Date(exp * 1000).toISOString(),
      repoId: claims.repoId,
      repo: claims.repo,
      tier: claims.tier,
      branch: claims.branch,
      kind: claims.kind,
    });
  });

  return app;
}
