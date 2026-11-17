import type { TimingVariables } from "hono/timing";

import type { Env } from "./env.ts";
import type { FailureLimiter } from "./ratelimit.ts";
import type { SessionClaims } from "./session/token.ts";
import type { StatsKeyEntry } from "./stats/auth.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    session: SessionClaims;
    statsKey: StatsKeyEntry;
    /** Limiter for failed credentials (ratelimit.ts); undefined when off. */
    failureLimiter: FailureLimiter | undefined;
  } & TimingVariables;
}
