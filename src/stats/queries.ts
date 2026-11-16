import { COLUMNS } from "../metrics/record.ts";
import { SESSION_KINDS, TIERS } from "../session/token.ts";

// Build the /v1/stats SQL and shape the rows. Only already-validated values are
// interpolated: an integer repoId, a range from a fixed list and a validated dataset name.

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

function assertRepoId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new Error("invalid repoId");
}

export function since(range: Range): string {
  const [amount, unit] = RANGES[range];
  return `timestamp > NOW() - INTERVAL '${amount}' ${unit}`;
}

function where(repoId: number, range: Range): string {
  assertRepoId(repoId);
  return `index1 = '${repoId}' AND ${since(range)}`;
}

/** `index1 = 'a' OR …` entre paréntesis; sin lista, nada (la llave ve todos los repos). */
export function repoFilter(repoIds: readonly number[] | undefined): string {
  if (repoIds === undefined) return "";
  if (repoIds.length === 0) return " AND 1 = 0";
  for (const id of repoIds) assertRepoId(id);
  return ` AND (${repoIds.map((id) => `index1 = '${id}'`).join(" OR ")})`;
}

/** Requests, bytes and stored duration by tier × kind × protocol × result. */
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

/** Per branch (branch tier, `rama`): writes and reads by kind, result and who wrote what was read. */
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
  /** Total hits (including those served from main/). */
  hits: number;
  /** A branch's hits served from main/. */
  hitsFromMain: number;
  misses: number;
  writes: number;
  bytesRead: number;
  bytesWritten: number;
  /** Sum of the stored duration of the artifacts hit (only Turbo reports it). */
  timeSavedMs: number;
  /** hits / (hits + misses); null with no reads. */
  hitRate: number | null;
}

const PROTOCOLS = ["turbo", "sccache"] as const;

export function emptyCounters(): Counters {
  return { requests: 0, hits: 0, hitsFromMain: 0, misses: 0, writes: 0, bytesRead: 0, bytesWritten: 0, timeSavedMs: 0, hitRate: null };
}

export const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function addResult(counters: Counters, result: string, requests: number, bytes: number, durationMs: number) {
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

export function finish(counters: Counters): Counters {
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
    addResult(totals, result, ...values);
    const tier = String(row.tier) as keyof typeof byTier;
    if (Object.hasOwn(byTier, tier)) addResult(byTier[tier], result, ...values);
    const kind = String(row.kind) as keyof typeof byKind;
    if (Object.hasOwn(byKind, kind)) addResult(byKind[kind], result, ...values);
    const protocol = String(row.protocol) as keyof typeof byProtocol;
    if (Object.hasOwn(byProtocol, protocol)) addResult(byProtocol[protocol], result, ...values);
  }
  for (const counters of [totals, ...Object.values(byTier), ...Object.values(byKind), ...Object.values(byProtocol)]) {
    finish(counters);
  }
  return { totals, byTier, byKind, byProtocol };
}

export interface BranchStats {
  branch: string;
  /** Objects the sandbox wrote on the branch. */
  sandboxWrites: number;
  /** CI reads on the branch (hits + misses). */
  ciReads: number;
  /** CI hits (from the branch or from main/). */
  ciHits: number;
  /** CI hits on objects the sandbox wrote: the reuse we are after. */
  ciHitsOnSandboxObjects: number;
  /** The sandbox wrote ≥ N and CI reused none: something differs between them (path, toolchain, flags). */
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
