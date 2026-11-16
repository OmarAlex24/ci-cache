import { Hono, type Context } from "hono";

import { readConfig } from "../config.ts";
import type { Env } from "../env.ts";
import { badRequest, forbidden } from "../errors.ts";
import type { AppEnv } from "../types.ts";
import type { AnalyticsClient } from "./analytics.ts";
import { sandboxRepoNames } from "../session/keys.ts";
import { requireStatsKey } from "./auth.ts";
import { branchesSql, DEFAULT_RANGE, isRange, shapeBranches, shapeStats, statsSql, type Range } from "./queries.ts";
import { repoBranchesSql, reposSql, shapeRepos } from "./repos.ts";

const REPO_ID = /^[1-9][0-9]{0,15}$/u;

function readRange(c: Context<AppEnv>): Range {
  const range = c.req.query("range") ?? DEFAULT_RANGE;
  if (!isRange(range)) throw badRequest("range must be 1h, 24h, 7d, 30d or 90d");
  return range;
}

function readParams(c: Context<AppEnv>): { repoId: number; range: Range } {
  const repo = c.req.query("repo");
  if (!repo || !REPO_ID.test(repo) || !Number.isSafeInteger(Number(repo))) {
    throw badRequest("repo must be the numeric repository id");
  }
  const range = readRange(c);
  const repoId = Number(repo);
  const allowed = c.get("statsKey")?.repoIds;
  if (allowed && !allowed.includes(repoId)) throw forbidden("This key cannot see that repository");
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

  // No ?repo=: a limited key only sees its repos (a filter, not a 403).
  app.get("/v1/stats/repos", async (c) => {
    const range = readRange(c);
    const allowed = c.get("statsKey")?.repoIds;
    const { metricsDataset, reuseAlertMinWrites } = readConfig(c.env);
    const analytics = deps.analytics(c.env);
    const [rows, branchRows] = await Promise.all([
      analytics.query(reposSql(metricsDataset, range, allowed)),
      analytics.query(repoBranchesSql(metricsDataset, range, allowed)),
    ]);
    const knownNames = sandboxRepoNames(c.env.SANDBOX_KEYS);
    c.header("cache-control", "no-store");
    return c.json({
      range,
      generatedAt: new Date().toISOString(),
      reuseAlertMinWrites,
      repos: shapeRepos(rows, branchRows, { minWrites: reuseAlertMinWrites, knownNames }),
    });
  });

  return app;
}
