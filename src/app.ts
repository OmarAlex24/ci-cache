import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";

import { davRoutes } from "./dav/routes.ts";
import { HttpError, jsonError } from "./errors.ts";
import { sessionRoutes } from "./session/routes.ts";
import { turboRoutes } from "./turbo/routes.ts";
import type { AppEnv } from "./types.ts";

export interface AppDeps {
  jwks: JWTVerifyGetKey;
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/", sessionRoutes(deps));
  app.route("/", turboRoutes());
  app.route("/", davRoutes());

  app.notFound((c) => jsonError(c, 404, "not_found", "Ruta no encontrada"));
  app.onError((error, c) => {
    if (error instanceof HttpError) return jsonError(c, error.status, error.code, error.message);
    // Solo el tipo de error: nunca cabeceras ni cuerpos (podrían llevar tokens).
    console.error("error interno:", error instanceof Error ? error.name : typeof error);
    return jsonError(c, 500, "internal_error", "Error interno");
  });

  return app;
}
