import { createMiddleware } from "hono/factory";

import { unauthorized } from "../errors.ts";
import { readBearer } from "../http.ts";
import { findKey, parseHashMap } from "../session/keys.ts";
import type { AppEnv } from "../types.ts";

/** Llave de solo lectura de métricas. `repoIds` opcional limita qué repos puede ver. */
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

/** Exige una llave de STATS_KEYS. Los tokens de sesión y las llaves de sandbox no sirven aquí. */
export const requireStatsKey = createMiddleware<AppEnv>(async (c, next) => {
  const key = readBearer(c);
  if (!key) throw unauthorized();
  const entry = await findKey(statsEntries(c.env.STATS_KEYS), key);
  if (!entry) throw unauthorized();
  c.set("statsKey", entry);
  await next();
});
