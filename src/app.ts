import { Hono } from "hono";
import { timing } from "hono/timing";
import type { JWTVerifyGetKey } from "jose";

import { davRoutes } from "./dav/routes.ts";
import type { Env } from "./env.ts";
import { HttpError, jsonError } from "./errors.ts";
import { sessionRoutes } from "./session/routes.ts";
import { analyticsFromEnv, type AnalyticsClient } from "./stats/analytics.ts";
import { statsRoutes } from "./stats/routes.ts";
import { turboRoutes } from "./turbo/routes.ts";
import type { AppEnv } from "./types.ts";

export interface AppDeps {
  jwks: JWTVerifyGetKey;
  /** Analytics Engine SQL API client (injectable for tests). */
  analytics?: (env: Env) => AnalyticsClient;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  // Server-Timing on every response: `session` (verifying the token), `r2-own`/`r2-main`
  // (each R2 read) and `total` (until the Worker returns the response; the R2 body keeps
  // streaming afterwards, so `total` is the Worker's first byte).
  app.use(timing({ totalDescription: "" }));

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", sessionRoutes(deps));
  app.route("/", turboRoutes());
  app.route("/", davRoutes());
  app.route("/", statsRoutes({ analytics: deps.analytics ?? analyticsFromEnv }));

  app.notFound((c) => jsonError(c, 404, "not_found", "Route not found"));
  app.onError((error, c) => {
    if (error instanceof HttpError) return jsonError(c, error.status, error.code, error.message);
    // Only the error type: never headers or bodies (they could carry tokens).
    console.error("internal error:", error instanceof Error ? error.name : typeof error);
    return jsonError(c, 500, "internal_error", "Internal error");
  });

  return app;
}
