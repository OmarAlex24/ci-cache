import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";

import { readConfig, readSessionSecret } from "../config.ts";
import { badRequest, unauthorized } from "../errors.ts";
import { readBearer, readSmallJson } from "../http.ts";
import type { AppEnv } from "../types.ts";
import { findSandboxKey } from "./keys.ts";
import { verifyGithubOidc } from "./oidc.ts";
import { signSession, type SessionClaims } from "./token.ts";

export const SANDBOX_KEY_PREFIX = "sk_";

// Nombre de rama al estilo git: sin espacios ni controles, sin `~^:?*[\`, sin `..`,
// sin `/` al inicio o al final. Solo se usa hasheado en las llaves de R2.
// oxlint-disable-next-line no-control-regex -- excluir controles es justo la intención
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[^\x00-\x20\x7f~^:?*[\\]{1,255}$/u;

function readBranch(body: unknown): string {
  if (typeof body !== "object" || body === null) throw badRequest("Falta el campo branch");
  const branch = (body as Record<string, unknown>).branch;
  if (typeof branch !== "string" || !BRANCH.test(branch)) throw badRequest("branch inválida");
  return branch;
}

export function sessionRoutes(deps: { jwks: JWTVerifyGetKey }) {
  const app = new Hono<AppEnv>();

  app.post("/v1/session", async (c) => {
    const credential = readBearer(c);
    if (!credential) throw unauthorized();
    const config = readConfig(c.env);
    const secret = readSessionSecret(c.env);
    const now = Math.floor(Date.now() / 1000);
    const exp = now + config.sessionTtlSeconds;

    let claims: SessionClaims;
    if (credential.startsWith(SANDBOX_KEY_PREFIX)) {
      const branch = readBranch(await readSmallJson(c, 4096));
      const entry = await findSandboxKey(c.env.SANDBOX_KEYS, credential);
      if (!entry) throw unauthorized();
      // Una llave de sandbox siempre da nivel rama, aunque la rama se llame main.
      claims = { v: 1, repoId: entry.repoId, repo: entry.repo, tier: "rama", branch, kind: "sandbox", exp };
    } else {
      const identity = await verifyGithubOidc(credential, config, deps.jwks);
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
