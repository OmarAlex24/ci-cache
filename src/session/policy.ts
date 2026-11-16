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
 * Decides the tier from who the client is (never from what it asks for). Order:
 * 1. a write event (push) on a main ref → `main`;
 * 2. has `head_ref` (pull_request, pull_request_target) → `rama` (branch tier) = head_ref;
 * 3. another event on a main ref (schedule, workflow_dispatch...) → `main-ro`;
 * 4. any other ref → `rama` = the ref's name.
 * Step 2 comes before step 3 because pull_request_target carries `ref` = the base branch (main).
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
