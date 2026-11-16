import { COLUMNS } from "../metrics/record.ts";
import { addResult, emptyCounters, finish, num, repoFilter, shapeBranches, since, type Counters, type Range } from "./queries.ts";

// GET /v1/stats/repos: the repos with traffic in the range, without the client knowing their ids.
// Two queries: totals per repo (and the latest request) and the branches, to count each
// repo's reuseAlerts with the same rule as /v1/stats/branches.

/** Totals and latest request by repo, name (blob8; empty in old data points) and result. */
export function reposSql(dataset: string, range: Range, repoIds?: readonly number[]): string {
  return [
    `SELECT ${COLUMNS.repoId} AS repo_id, ${COLUMNS.repo} AS repo, ${COLUMNS.result} AS result,`,
    `  SUM(_sample_interval) AS requests,`,
    `  SUM(_sample_interval * ${COLUMNS.bytes}) AS bytes,`,
    `  SUM(_sample_interval * ${COLUMNS.durationMs}) AS duration_ms,`,
    `  MAX(timestamp) AS last_seen`,
    `FROM ${dataset}`,
    `WHERE ${since(range)}${repoFilter(repoIds)}`,
    `GROUP BY repo_id, repo, result`,
    `LIMIT 10000`,
    `FORMAT JSON`,
  ].join("\n");
}

/** The same as branchesSql, for every repo at once. */
export function repoBranchesSql(dataset: string, range: Range, repoIds?: readonly number[]): string {
  return [
    `SELECT ${COLUMNS.repoId} AS repo_id, ${COLUMNS.branch} AS branch, ${COLUMNS.kind} AS kind, ${COLUMNS.result} AS result, ${COLUMNS.writerKind} AS writer_kind,`,
    `  SUM(_sample_interval) AS requests`,
    `FROM ${dataset}`,
    `WHERE ${since(range)}${repoFilter(repoIds)} AND ${COLUMNS.tier} = 'rama'`,
    `GROUP BY repo_id, branch, kind, result, writer_kind`,
    `LIMIT 10000`,
    `FORMAT JSON`,
  ].join("\n");
}

export interface RepoStats {
  repoId: number;
  /** `owner/repo` from the most recent data points or SANDBOX_KEYS; null if nobody knows it. */
  repo: string | null;
  /** The most recent request in the range (ISO 8601, UTC). */
  lastSeenAt: string | null;
  totals: Counters;
  /** Branches with reuseAlert in the range. */
  reuseAlerts: number;
}

const AE_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u;

/** AE returns `YYYY-MM-DD HH:MM:SS` in UTC; ISO and Unix seconds are accepted too. */
export function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return new Date(value * 1000).toISOString();
  if (typeof value !== "string" || value === "") return null;
  const match = AE_DATETIME.exec(value);
  const date = new Date(match ? `${match[1]}T${match[2]}Z` : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const repoIdOf = (row: Record<string, unknown>): number | null => {
  const id = Number(row.repo_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

interface Draft {
  stats: RepoStats;
  /** Date of the data point that gave the name: if the repo was renamed, the most recent wins. */
  namedAt: string;
}

function draftFor(drafts: Map<number, Draft>, repoId: number): Draft {
  let draft = drafts.get(repoId);
  if (!draft) {
    draft = { stats: { repoId, repo: null, lastSeenAt: null, totals: emptyCounters(), reuseAlerts: 0 }, namedAt: "" };
    drafts.set(repoId, draft);
  }
  return draft;
}

function countAlerts(branchRows: Record<string, unknown>[], minWrites: number): Map<number, number> {
  const byRepo = new Map<number, Record<string, unknown>[]>();
  for (const row of branchRows) {
    const repoId = repoIdOf(row);
    if (repoId === null) continue;
    const list = byRepo.get(repoId) ?? [];
    list.push(row);
    byRepo.set(repoId, list);
  }
  return new Map([...byRepo].map(([repoId, rows]) => [repoId, shapeBranches(rows, minWrites).filter((b) => b.reuseAlert).length]));
}

export function shapeRepos(
  rows: Record<string, unknown>[],
  branchRows: Record<string, unknown>[],
  options: { minWrites: number; knownNames: ReadonlyMap<number, string> },
): RepoStats[] {
  const drafts = new Map<number, Draft>();
  for (const row of rows) {
    const repoId = repoIdOf(row);
    if (repoId === null) continue;
    const draft = draftFor(drafts, repoId);
    addResult(draft.stats.totals, String(row.result), num(row.requests), num(row.bytes), num(row.duration_ms));
    const seen = toIso(row.last_seen);
    if (seen !== null && (draft.stats.lastSeenAt === null || seen > draft.stats.lastSeenAt)) draft.stats.lastSeenAt = seen;
    const name = typeof row.repo === "string" ? row.repo : "";
    if (name !== "" && (seen ?? "") >= draft.namedAt) {
      draft.stats.repo = name;
      draft.namedAt = seen ?? "";
    }
  }
  const alerts = countAlerts(branchRows, options.minWrites);
  const list = [...drafts.values()].map(({ stats }) => {
    finish(stats.totals);
    stats.repo ??= options.knownNames.get(stats.repoId) ?? null;
    stats.reuseAlerts = alerts.get(stats.repoId) ?? 0;
    return stats;
  });
  return list.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") || a.repoId - b.repoId);
}
