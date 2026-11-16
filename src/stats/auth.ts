import { createMiddleware } from "hono/factory";

import { unauthorized } from "../errors.ts";
import { readBearer } from "../http.ts";
import { findKey, parseHashMap } from "../session/keys.ts";
import type { AppEnv } from "../types.ts";

/** Read-only metrics key. The optional `repoIds` limits which repos it can see. */
export interface StatsKeyEntry {
  label: string;
  repoIds?: number[];
}

function isStatsEntry(value: unknown): value is StatsKeyEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.label === "string" &&
    (v.repoIds === undefined ||
      (Array.isArray(v.repoIds) && v.repoIds.every((id) => Number.isSafeInteger(id) && (id as number) > 0)))
  );
}

let cache: { source: string; entries: [string, StatsKeyEntry][] } | undefined;

function statsEntries(source: string | undefined): [string, StatsKeyEntry][] {
  if (cache?.source !== (source ?? "")) cache = { source: source ?? "", entries: parseHashMap(source, isStatsEntry) };
  return cache.entries;
}

/** Requires a key from STATS_KEYS. Session tokens and sandbox keys don't work here. */
export const requireStatsKey = createMiddleware<AppEnv>(async (c, next) => {
  const key = readBearer(c);
  if (!key) throw unauthorized();
  const entry = await findKey(statsEntries(c.env.STATS_KEYS), key);
  if (!entry) throw unauthorized();
  c.set("statsKey", entry);
  await next();
});
