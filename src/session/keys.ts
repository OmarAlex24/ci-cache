import { constantTimeEqual, sha256Hex } from "../crypto.ts";
import { HttpError } from "../errors.ts";

/**
 * Keys stored as hashes: `{ "<sha256 hex of the key>": entry }`. The plaintext key is
 * never stored in the Worker. It is compared against every entry in constant time so as
 * not to leak which one exists.
 */
export interface SandboxKeyEntry {
  repoId: number;
  repo: string;
  label: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const misconfigured = () => new HttpError(500, "misconfigured", "The service is not configured");

type Parsed<T> = { source: string; entries: [string, T][] };
let sandboxCache: Parsed<SandboxKeyEntry> | undefined;

function parseHashMap<T>(source: string | undefined, check: (value: unknown) => value is T): [string, T][] {
  if (source === undefined || source.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw misconfigured();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw misconfigured();
  return Object.entries(parsed).map(([hash, value]) => {
    if (!HASH.test(hash) || !check(value)) throw misconfigured();
    return [hash, value];
  });
}

function isSandboxEntry(value: unknown): value is SandboxKeyEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.repoId === "number" &&
    Number.isSafeInteger(v.repoId) &&
    v.repoId > 0 &&
    typeof v.repo === "string" &&
    v.repo !== "" &&
    typeof v.label === "string"
  );
}

function sandboxEntries(source: string | undefined): [string, SandboxKeyEntry][] {
  if (sandboxCache?.source !== (source ?? "")) {
    sandboxCache = { source: source ?? "", entries: parseHashMap(source, isSandboxEntry) };
  }
  return sandboxCache.entries;
}

/** Looks up a key by comparing its hash with every entry, without short-circuiting. */
export async function findKey<T>(entries: [string, T][], key: string): Promise<T | undefined> {
  const hash = await sha256Hex(key);
  let found: T | undefined;
  for (const [candidate, entry] of entries) {
    if (constantTimeEqual(candidate, hash)) found = entry;
  }
  return found;
}

export async function findSandboxKey(source: string | undefined, key: string): Promise<SandboxKeyEntry | undefined> {
  return findKey(sandboxEntries(source), key);
}

/**
 * Nombre de cada repo según SANDBOX_KEYS, para los puntos de métricas anteriores a que
 * guardaran el nombre. Nunca rompe /v1/stats: un secret mal formado da un mapa vacío.
 */
export function sandboxRepoNames(source: string | undefined): Map<number, string> {
  try {
    return new Map(sandboxEntries(source).map(([, entry]) => [entry.repoId, entry.repo]));
  } catch {
    return new Map();
  }
}

export { parseHashMap };
