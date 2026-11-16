import type { Context } from "hono";

import type { Protocol } from "../storage/tiers.ts";
import type { AppEnv } from "../types.ts";

export type CacheResult = "hit" | "hit-main" | "miss" | "write";

export interface CacheEvent {
  protocol: Protocol;
  result: CacheResult;
  /** Who wrote the object that was read (`ci` | `sandbox`); empty on misses and on unrelated writes. */
  writerKind: string;
  bytes: number;
  /** The artifact's stored duration (Turbo's x-artifact-duration), in ms. */
  durationMs: number;
}

/**
 * Fixed column order in Analytics Engine (the /v1/stats queries depend on it):
 *   index1 = repoId
 *   blob1 = repoId, blob2 = tier, blob3 = kind, blob4 = protocol, blob5 = result,
 *   blob6 = writer-kind of the object read, blob7 = branch, blob8 = repo name (owner/repo)
 *   double1 = bytes, double2 = stored duration (ms)
 */
export const COLUMNS = {
  repoId: "blob1",
  tier: "blob2",
  kind: "blob3",
  protocol: "blob4",
  result: "blob5",
  writerKind: "blob6",
  branch: "blob7",
  /** Desde /v1/stats/repos; los puntos anteriores lo traen vacío. */
  repo: "blob8",
  bytes: "double1",
  durationMs: "double2",
} as const;

/** One data point per cache request. Never breaks the request if it fails. */
export function recordCacheEvent(c: Context<AppEnv>, event: CacheEvent): void {
  const metrics = c.env.METRICS;
  if (!metrics) return;
  const session = c.get("session");
  try {
    metrics.writeDataPoint({
      indexes: [String(session.repoId)],
      blobs: [
        String(session.repoId),
        session.tier,
        session.kind,
        event.protocol,
        event.result,
        event.writerKind,
        session.branch,
        session.repo,
      ],
      doubles: [event.bytes, Number.isFinite(event.durationMs) ? event.durationMs : 0],
    });
  } catch {
    console.error("could not record the metric");
  }
}
