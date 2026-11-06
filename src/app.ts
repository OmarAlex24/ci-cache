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
  /** Cliente de la API SQL de Analytics Engine (inyectable para pruebas). */
  analytics?: (env: Env) => AnalyticsClient;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  // Server-Timing en toda respuesta: `session` (verificar el token), `r2-own`/`r2-main`
  // (cada lectura de R2) y `total` (hasta que el Worker devuelve la respuesta; el cuerpo
  // de R2 sigue en streaming después, así que `total` es el primer byte del Worker).
  app.use(timing({ totalDescription: "" }));

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", sessionRoutes(deps));
  app.route("/", turboRoutes());
  app.route("/", davRoutes());
  app.route("/", statsRoutes({ analytics: deps.analytics ?? analyticsFromEnv }));

  app.notFound((c) => jsonError(c, 404, "not_found", "Ruta no encontrada"));
  app.onError((error, c) => {
    if (error instanceof HttpError) return jsonError(c, error.status, error.code, error.message);
    // Solo el tipo de error: nunca cabeceras ni cuerpos (podrían llevar tokens).
    console.error("error interno:", error instanceof Error ? error.name : typeof error);
    return jsonError(c, 500, "internal_error", "Error interno");
  });

  return app;
}
