import { Hono, type Context } from "hono";

import { readConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { badRequest, forbidden } from "../errors.ts";
import type { AppEnv } from "../types.ts";
import type { AnalyticsClient } from "./analytics.ts";
import { requireStatsKey } from "./auth.ts";
import { branchesSql, DEFAULT_RANGE, isRange, shapeBranches, shapeStats, statsSql, type Range } from "./queries.ts";

const REPO_ID = /^[1-9][0-9]{0,15}$/u;

function readParams(c: Context<AppEnv>): { repoId: number; range: Range } {
  const repo = c.req.query("repo");
  if (!repo || !REPO_ID.test(repo) || !Number.isSafeInteger(Number(repo))) {
    throw badRequest("repo debe ser el id numérico del repositorio");
  }
  const range = c.req.query("range") ?? DEFAULT_RANGE;
  if (!isRange(range)) throw badRequest("range debe ser 1h, 24h, 7d, 30d o 90d");
  const repoId = Number(repo);
  const allowed = c.get("statsKey")?.repoIds;
  if (allowed && !allowed.includes(repoId)) throw forbidden("Esta llave no puede ver ese repositorio");
  return { repoId, range };
}

export function statsRoutes(deps: { analytics: (env: Env) => AnalyticsClient }) {
  const app = new Hono<AppEnv>();
  app.use("/v1/stats", requireStatsKey);
  app.use("/v1/stats/*", requireStatsKey);

  app.get("/v1/stats", async (c) => {
    const { repoId, range } = readParams(c);
    const { metricsDataset } = readConfig(c.env);
    const rows = await deps.analytics(c.env).query(statsSql(metricsDataset, repoId, range));
    c.header("cache-control", "no-store");
    return c.json({ repoId, range, generatedAt: new Date().toISOString(), ...shapeStats(rows) });
  });

  app.get("/v1/stats/branches", async (c) => {
    const { repoId, range } = readParams(c);
    const { metricsDataset, reuseAlertMinWrites } = readConfig(c.env);
    const rows = await deps.analytics(c.env).query(branchesSql(metricsDataset, repoId, range));
    c.header("cache-control", "no-store");
    return c.json({
      repoId,
      range,
      generatedAt: new Date().toISOString(),
      reuseAlertMinWrites,
      branches: shapeBranches(rows, reuseAlertMinWrites),
    });
  });

  return app;
}
