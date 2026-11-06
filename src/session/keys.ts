import { constantTimeEqual, sha256Hex } from "../crypto.ts";
import { HttpError } from "../errors.ts";

/**
 * Llaves guardadas como hashes: `{ "<sha256 hex de la llave>": entrada }`. La llave en
 * claro nunca se guarda en el Worker. Se compara contra todas las entradas en tiempo
 * constante para no filtrar cuál existe.
 */
export interface SandboxKeyEntry {
  repoId: number;
  repo: string;
  label: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const misconfigured = () => new HttpError(500, "misconfigured", "El servicio no está configurado");

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

/** Busca una llave comparando su hash con todas las entradas, sin cortocircuito. */
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

export { parseHashMap };
