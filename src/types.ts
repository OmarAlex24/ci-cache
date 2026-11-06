import type { Env } from "./env.ts";
import type { SessionClaims } from "./session/token.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: { session: SessionClaims };
}
