import type { TimingVariables } from "hono/timing";

import type { Env } from "./env.ts";
import type { SessionClaims } from "./session/token.ts";
import type { StatsKeyEntry } from "./stats/auth.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: { session: SessionClaims; statsKey: StatsKeyEntry } & TimingVariables;
}
