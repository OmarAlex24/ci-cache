import { branchKey } from "../crypto.ts";
import type { SessionClaims } from "../session/token.ts";
import { untimed, type Timer } from "../timing.ts";

/** Protocolos que comparten el layout `<nivel>/<repoId>[/<branchKey>]/<protocolo>/...`. */
export type Protocol = "turbo" | "sccache";

/** De dónde salió una lectura: la rama de la sesión o main/. */
export type ReadSource = "own" | "main";

export interface TierLayout {
  /** Prefijo donde escribe la sesión; null si es de solo lectura (main-ro). */
  write: string | null;
  /** Prefijos de lectura en orden: primero el propio, luego main/ si aplica. */
  read: { prefix: string; source: ReadSource }[];
}

export function mainPrefix(repoId: number, protocol: Protocol): string {
  return `main/${repoId}/${protocol}/`;
}

export async function branchPrefix(repoId: number, branch: string, protocol: Protocol): Promise<string> {
  return `ramas/${repoId}/${await branchKey(branch)}/${protocol}/`;
}

/**
 * Traduce el nivel de la sesión a prefijos de R2:
 * - main:    lee y escribe main/.
 * - main-ro: solo lee main/ (nunca ramas/).
 * - rama:    lee y escribe su rama; si no está, lee main/.
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

/** Resultado para métricas: `hit-main` = una rama acertó gracias a main/. */
export function readResult(session: SessionClaims, source: ReadSource | null): ReadResult {
  if (source === null) return "miss";
  return session.tier === "rama" && source === "main" ? "hit-main" : "hit";
}

/**
 * GET con fallback: devuelve el primer objeto encontrado y de qué prefijo salió.
 * `time` mide cada lectura como `r2-own` / `r2-main` (Server-Timing).
 */
export async function getWithFallback(
  bucket: R2Bucket,
  layout: TierLayout,
  name: string,
  time: Timer = untimed,
): Promise<{ object: R2ObjectBody; source: ReadSource } | null> {
  for (const { prefix, source } of layout.read) {
    const object = await time(`r2-${source}`, () => bucket.get(prefix + name));
    if (object) return { object, source };
  }
  return null;
}

/** HEAD con fallback. */
export async function headWithFallback(
  bucket: R2Bucket,
  layout: TierLayout,
  name: string,
  time: Timer = untimed,
): Promise<{ object: R2Object; source: ReadSource } | null> {
  for (const { prefix, source } of layout.read) {
    const object = await time(`r2-${source}`, () => bucket.head(prefix + name));
    if (object) return { object, source };
  }
  return null;
}
