import { branchKey } from "../crypto.ts";
import type { SessionClaims } from "../session/token.ts";
import { untimed, type Timer } from "../timing.ts";

/** Protocols that share the `<tier>/<repoId>[/<branchKey>]/<protocol>/...` layout. */
export type Protocol = "turbo" | "sccache";

/** Where a read came from: the session's branch or main/. */
export type ReadSource = "own" | "main";

export interface TierLayout {
  /** Prefix the session writes to; null if it is read-only (main-ro). */
  write: string | null;
  /** Read prefixes in order: its own first, then main/ if applicable. */
  read: { prefix: string; source: ReadSource }[];
}

export function mainPrefix(repoId: number, protocol: Protocol): string {
  return `main/${repoId}/${protocol}/`;
}

export async function branchPrefix(repoId: number, branch: string, protocol: Protocol): Promise<string> {
  return `ramas/${repoId}/${await branchKey(branch)}/${protocol}/`;
}

/**
 * Maps the session's tier to R2 prefixes:
 * - main:    reads and writes main/.
 * - main-ro: only reads main/ (never ramas/).
 * - rama:    (the branch tier) reads and writes its branch; if missing, reads main/.
 */
export async function tierLayout(session: SessionClaims, protocol: Protocol): Promise<TierLayout> {
  const main = mainPrefix(session.repoId, protocol);
  switch (session.tier) {
    case "main":
      return { write: main, read: [{ prefix: main, source: "main" }] };
    case "main-ro":
      return { write: null, read: [{ prefix: main, source: "main" }] };
    case "rama": {
      const own = await branchPrefix(session.repoId, session.branch, protocol);
      return { write: own, read: [{ prefix: own, source: "own" }, { prefix: main, source: "main" }] };
    }
  }
}

export type ReadResult = "hit" | "hit-main" | "miss";

/** Result for metrics: `hit-main` = a branch hit thanks to main/. */
export function readResult(session: SessionClaims, source: ReadSource | null): ReadResult {
  if (source === null) return "miss";
  return session.tier === "rama" && source === "main" ? "hit-main" : "hit";
}

/**
 * Reads the tier's prefixes **concurrently** and keeps the first one that exists, in
 * `layout.read` order (the branch before main/). That way a branch miss or a hit from
 * main/ costs one R2 round trip instead of two; in exchange, a branch makes two R2 read
 * operations per request. Reads that are not needed are discarded.
 */
async function firstInOrder<T>(
  layout: TierLayout,
  read: (prefix: string, source: ReadSource) => Promise<T | null>,
  release: (value: T) => void,
  concurrent = true,
): Promise<{ object: T; source: ReadSource } | null> {
  if (!concurrent) {
    for (const { prefix, source } of layout.read) {
      const object = await read(prefix, source);
      if (object) return { object, source };
    }
    return null;
  }
  const pending = layout.read.map(({ prefix, source }) => ({ source, result: read(prefix, source) }));
  let index = 0;
  try {
    for (; index < pending.length; index++) {
      const { source, result } = pending[index]!;
      const object = await result;
      if (object) return { object, source };
    }
    return null;
  } finally {
    // The ones no longer needed: release the body and don't leave their errors unhandled.
    for (const rest of pending.slice(index + 1)) {
      rest.result.then((value) => value && release(value), () => undefined);
    }
  }
}

/**
 * GET with fallback: returns the first object found and which prefix it came from.
 * `time` measures each read as `r2-own` / `r2-main` (Server-Timing).
 */
export function getWithFallback(
  bucket: R2Bucket,
  layout: TierLayout,
  name: string,
  time: Timer = untimed,
): Promise<{ object: R2ObjectBody; source: ReadSource } | null> {
  return firstInOrder(
    layout,
    (prefix, source) => time(`r2-${source}`, () => bucket.get(prefix + name)),
    (object) => void object.body.cancel().catch(() => undefined),
  );
}

/**
 * HEAD with fallback. `concurrent: false` reads main/ only if the branch doesn't have it:
 * for Turbo's batch query, which already fires hundreds of HEADs in parallel and gains
 * nothing from doubling the R2 operations (they count against the Worker's subrequest limit).
 */
export function headWithFallback(
  bucket: R2Bucket,
  layout: TierLayout,
  name: string,
  time: Timer = untimed,
  concurrent = true,
): Promise<{ object: R2Object; source: ReadSource } | null> {
  return firstInOrder(
    layout,
    (prefix, source) => time(`r2-${source}`, () => bucket.head(prefix + name)),
    () => undefined,
    concurrent,
  );
}
