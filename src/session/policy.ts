import type { Tier } from "./token.ts";

export interface GithubRunClaims {
  event_name: string;
  ref: string;
  head_ref?: string | undefined;
}

export interface TierPolicy {
  mainWriteEvents: ReadonlySet<string>;
  mainRefs: ReadonlySet<string>;
}

const HEADS = "refs/heads/";

function refName(ref: string): string {
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

/**
 * Decide el nivel a partir de quién es el cliente (nunca de lo que pida). Orden:
 * 1. evento de escritura (push) sobre una ref de main → `main`;
 * 2. trae `head_ref` (pull_request, pull_request_target) → `rama` = head_ref;
 * 3. otro evento sobre una ref de main (schedule, workflow_dispatch...) → `main-ro`;
 * 4. cualquier otra ref → `rama` = nombre de la ref.
 * El paso 2 va antes del 3 porque pull_request_target trae `ref` = rama base (main).
 */
export function resolveTier(claims: GithubRunClaims, policy: TierPolicy): { tier: Tier; branch: string } {
  const onMainRef = policy.mainRefs.has(claims.ref);
  if (onMainRef && policy.mainWriteEvents.has(claims.event_name)) {
    return { tier: "main", branch: refName(claims.ref) };
  }
  if (claims.head_ref) return { tier: "rama", branch: claims.head_ref };
  if (onMainRef) return { tier: "main-ro", branch: refName(claims.ref) };
  return { tier: "rama", branch: refName(claims.ref) };
}
