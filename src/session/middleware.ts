import { createMiddleware } from "hono/factory";

import { readSessionSecret } from "../config.ts";
import { unauthorized } from "../errors.ts";
import { readBearer } from "../http.ts";
import { rejectCredential } from "../ratelimit.ts";
import { timer } from "../timing.ts";
import type { AppEnv } from "../types.ts";
import { verifySession } from "./token.ts";

/**
 * Requires a valid session token (only verifies the HMAC signature: cheap). A missing or
 * bad token counts against the client IP's failed-credential limit (ratelimit.ts).
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = readBearer(c);
  if (!token) return rejectCredential(c, unauthorized());
  const claims = await timer(c)("session", () =>
    verifySession(token, readSessionSecret(c.env), Math.floor(Date.now() / 1000)),
  );
  if (!claims) return rejectCredential(c, unauthorized());
  c.set("session", claims);
  await next();
});
