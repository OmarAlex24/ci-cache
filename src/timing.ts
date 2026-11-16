import type { Context } from "hono";
import { wrapTime } from "hono/timing";

import type { AppEnv } from "./types.ts";

/**
 * Times an async operation and adds it to the response's `Server-Timing` header
 * (Hono's `timing()` middleware, mounted in app.ts). This lets the client tell how much
 * of a read is network and how much is the Worker or R2.
 */
export type Timer = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export function timer(c: Context<AppEnv>): Timer {
  return (name, run) => wrapTime(c, name, run());
}

/** For code without a context (tests, batch queries): measures nothing. */
export const untimed: Timer = (_name, run) => run();
