import type { Context } from "hono";

import type { Protocol } from "../storage/tiers.ts";
import type { AppEnv } from "../types.ts";

export type CacheResult = "hit" | "hit-main" | "miss" | "write";

export interface CacheEvent {
  protocol: Protocol;
  result: CacheResult;
  /** Quién escribió el objeto leído (`ci` | `sandbox`); vacío en fallos y escrituras ajenas. */
  writerKind: string;
  bytes: number;
  /** Duración guardada del artefacto (x-artifact-duration de Turbo), en ms. */
  durationMs: number;
}

/**
 * Orden fijo de columnas en Analytics Engine (las consultas de /v1/stats dependen de él):
 *   index1 = repoId
 *   blob1 = repoId, blob2 = tier, blob3 = kind, blob4 = protocolo, blob5 = resultado,
 *   blob6 = writer-kind del objeto leído, blob7 = rama, blob8 = nombre del repo (owner/repo)
 *   double1 = bytes, double2 = duración guardada (ms)
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

/** Un punto por petición de caché. Nunca rompe la petición si falla. */
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
    console.error("no se pudo registrar la métrica");
  }
}
