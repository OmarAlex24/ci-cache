import { COLUMNS } from "../metrics/record.ts";
import { SESSION_KINDS, TIERS } from "../session/token.ts";

// Generan el SQL de /v1/stats y le dan forma a las filas. Solo se interpolan valores
// ya validados: repoId entero, rango de una lista fija y nombre de dataset validado.

export const RANGES = {
  "1h": [1, "HOUR"],
  "24h": [24, "HOUR"],
  "7d": [7, "DAY"],
  "30d": [30, "DAY"],
  "90d": [90, "DAY"],
} as const;
export type Range = keyof typeof RANGES;
export const DEFAULT_RANGE: Range = "7d";

export function isRange(value: string): value is Range {
  return Object.hasOwn(RANGES, value);
}

function where(repoId: number, range: Range): string {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new Error("repoId inválido");
  const [amount, unit] = RANGES[range];
  return `index1 = '${repoId}' AND timestamp > NOW() - INTERVAL '${amount}' ${unit}`;
}

/** Peticiones, bytes y duración guardada por nivel × kind × protocolo × resultado. */
export function statsSql(dataset: string, repoId: number, range: Range): string {
  return [
    `SELECT ${COLUMNS.tier} AS tier, ${COLUMNS.kind} AS kind, ${COLUMNS.protocol} AS protocol, ${COLUMNS.result} AS result,`,
    `  SUM(_sample_interval) AS requests,`,
    `  SUM(_sample_interval * ${COLUMNS.bytes}) AS bytes,`,
    `  SUM(_sample_interval * ${COLUMNS.durationMs}) AS duration_ms`,
    `FROM ${dataset}`,
    `WHERE ${where(repoId, range)}`,
    `GROUP BY tier, kind, protocol, result`,
    `FORMAT JSON`,
  ].join("\n");
}

/** Por rama (nivel rama): escrituras y lecturas por kind, resultado y quién escribió lo leído. */
export function branchesSql(dataset: string, repoId: number, range: Range): string {
  return [
    `SELECT ${COLUMNS.branch} AS branch, ${COLUMNS.kind} AS kind, ${COLUMNS.result} AS result, ${COLUMNS.writerKind} AS writer_kind,`,
    `  SUM(_sample_interval) AS requests`,
    `FROM ${dataset}`,
    `WHERE ${where(repoId, range)} AND ${COLUMNS.tier} = 'rama'`,
    `GROUP BY branch, kind, result, writer_kind`,
    `ORDER BY branch`,
    `LIMIT 10000`,
    `FORMAT JSON`,
  ].join("\n");
}

export interface Counters {
  requests: number;
  /** Aciertos totales (incluye los que vinieron de main/). */
  hits: number;
  /** Aciertos de una rama servidos desde main/. */
  hitsFromMain: number;
  misses: number;
  writes: number;
  bytesRead: number;
  bytesWritten: number;
  /** Suma de la duración guardada de los artefactos acertados (solo Turbo la reporta). */
  timeSavedMs: number;
  /** hits / (hits + misses); null sin lecturas. */
  hitRate: number | null;
}

const PROTOCOLS = ["turbo", "sccache"] as const;

function emptyCounters(): Counters {
  return { requests: 0, hits: 0, hitsFromMain: 0, misses: 0, writes: 0, bytesRead: 0, bytesWritten: 0, timeSavedMs: 0, hitRate: null };
}

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function add(counters: Counters, result: string, requests: number, bytes: number, durationMs: number) {
  counters.requests += requests;
  if (result === "hit" || result === "hit-main") {
    counters.hits += requests;
    counters.bytesRead += bytes;
    counters.timeSavedMs += durationMs;
    if (result === "hit-main") counters.hitsFromMain += requests;
  } else if (result === "miss") {
    counters.misses += requests;
  } else if (result === "write") {
    counters.writes += requests;
    counters.bytesWritten += bytes;
  }
}

function finish(counters: Counters): Counters {
  const reads = counters.hits + counters.misses;
  counters.hitRate = reads === 0 ? null : Math.round((counters.hits / reads) * 10_000) / 10_000;
  return counters;
}

function group<K extends string>(keys: readonly K[]): Record<K, Counters> {
  return Object.fromEntries(keys.map((key) => [key, emptyCounters()])) as Record<K, Counters>;
}

export function shapeStats(rows: Record<string, unknown>[]) {
  const totals = emptyCounters();
  const byTier = group(TIERS);
  const byKind = group(SESSION_KINDS);
  const byProtocol = group(PROTOCOLS);
  for (const row of rows) {
    const result = String(row.result);
    const values = [num(row.requests), num(row.bytes), num(row.duration_ms)] as const;
    add(totals, result, ...values);
    const tier = String(row.tier) as keyof typeof byTier;
    if (Object.hasOwn(byTier, tier)) add(byTier[tier], result, ...values);
    const kind = String(row.kind) as keyof typeof byKind;
    if (Object.hasOwn(byKind, kind)) add(byKind[kind], result, ...values);
    const protocol = String(row.protocol) as keyof typeof byProtocol;
    if (Object.hasOwn(byProtocol, protocol)) add(byProtocol[protocol], result, ...values);
  }
  for (const counters of [totals, ...Object.values(byTier), ...Object.values(byKind), ...Object.values(byProtocol)]) {
    finish(counters);
  }
  return { totals, byTier, byKind, byProtocol };
}

export interface BranchStats {
  branch: string;
  /** Objetos que escribió el sandbox en la rama. */
  sandboxWrites: number;
  /** Lecturas de la CI en la rama (aciertos + fallos). */
  ciReads: number;
  /** Aciertos de la CI (de la rama o de main/). */
  ciHits: number;
  /** Aciertos de la CI sobre objetos que escribió el sandbox: la reutilización que buscamos. */
  ciHitsOnSandboxObjects: number;
  /** El sandbox escribió ≥ N y la CI no aprovechó ninguno: algo difiere entre ambos (ruta, toolchain, banderas). */
  reuseAlert: boolean;
}

export function shapeBranches(rows: Record<string, unknown>[], minWrites: number): BranchStats[] {
  const branches = new Map<string, BranchStats>();
  for (const row of rows) {
    const branch = String(row.branch ?? "");
    if (branch === "") continue;
    let stats = branches.get(branch);
    if (!stats) {
      stats = { branch, sandboxWrites: 0, ciReads: 0, ciHits: 0, ciHitsOnSandboxObjects: 0, reuseAlert: false };
      branches.set(branch, stats);
    }
    const requests = num(row.requests);
    const result = String(row.result);
    const isHit = result === "hit" || result === "hit-main";
    if (row.kind === "sandbox" && result === "write") stats.sandboxWrites += requests;
    if (row.kind === "ci" && (isHit || result === "miss")) stats.ciReads += requests;
    if (row.kind === "ci" && isHit) stats.ciHits += requests;
    if (row.kind === "ci" && isHit && row.writer_kind === "sandbox") stats.ciHitsOnSandboxObjects += requests;
  }
  const list = [...branches.values()];
  for (const stats of list) {
    stats.reuseAlert = stats.sandboxWrites >= minWrites && stats.ciHitsOnSandboxObjects === 0;
  }
  return list.sort((a, b) => b.sandboxWrites - a.sandboxWrites || a.branch.localeCompare(b.branch));
}
