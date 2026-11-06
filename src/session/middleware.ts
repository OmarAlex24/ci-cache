import { createMiddleware } from "hono/factory";

import { readSessionSecret } from "../config.ts";
import { unauthorized } from "../errors.ts";
import { readBearer } from "../http.ts";
import { timer } from "../timing.ts";
import type { AppEnv } from "../types.ts";
import { verifySession } from "./token.ts";

/** Exige un token de sesión válido (solo verifica la firma HMAC: barato). */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const token = readBearer(c);
  if (!token) throw unauthorized();
  const claims = await timer(c)("session", () =>
    verifySession(token, readSessionSecret(c.env), Math.floor(Date.now() / 1000)),
  );
  if (!claims) throw unauthorized();
  c.set("session", claims);
  await next();
});
