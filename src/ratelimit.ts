import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { Env } from "./env.ts";
import { HttpError } from "./errors.ts";
import type { AppEnv } from "./types.ts";

/**
 * Rate limit for requests that arrive WITHOUT a valid credential (a missing or bad Bearer
 * on the cache routes, a failed `POST /v1/session`, a bad `rk_` key on /v1/stats).
 *
 * The limiter is only consulted after a credential has already been rejected, so a valid
 * token never reaches it: CI runners that share an IP with someone who sends garbage are
 * never limited. Once an IP exceeds the limit its failures answer 429 instead of 401/403.
 *
 * Shape of Cloudflare's Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc).
 */
export interface FailureLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Picks the limiter for a request; undefined turns limiting off. Injectable for tests. */
export type LimiterFactory = (env: Env) => FailureLimiter | undefined;

export const limiterFromEnv: LimiterFactory = (env) =>
  env.RATE_LIMIT_BAD_CREDENTIALS === "false" ? undefined : env.BAD_CREDENTIAL_LIMITER;

export const tooManyRequests = () => new HttpError(429, "rate_limited", "Too many requests");

/** Seconds a client should wait: the binding's longest period (10 or 60 s). */
export const RETRY_AFTER_SECONDS = 60;

/** Makes the request's limiter available to every route module (see app.ts). */
export function limiterMiddleware(factory: LimiterFactory) {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set("failureLimiter", factory(c.env));
    await next();
  });
}

/**
 * Counts one failed credential for the client's IP. Returns false if that IP is over the
 * limit. Fails open: no limiter, no `cf-connecting-ip` (Cloudflare always sets it at the
 * edge; only local tools and tests lack it) or a limiter error never block anyone.
 */
async function withinLimit(c: Context<AppEnv>): Promise<boolean> {
  const limiter = c.get("failureLimiter");
  const ip = c.req.header("cf-connecting-ip");
  if (!limiter || !ip) return true;
  try {
    return (await limiter.limit({ key: `bad-credential:${ip}` })).success;
  } catch {
    console.error("rate limiter unavailable");
    return true;
  }
}

/** Throws `error` (401/403) or, if the client's IP is over the limit, a 429. */
export async function rejectCredential(c: Context<AppEnv>, error: HttpError): Promise<never> {
  if (!(await withinLimit(c))) {
    c.header("retry-after", String(RETRY_AFTER_SECONDS));
    throw tooManyRequests();
  }
  throw error;
}

/** For code that throws HttpErrors while verifying a credential: counts 401 and 403 only. */
export async function countingFailures<T>(c: Context<AppEnv>, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      return rejectCredential(c, error);
    }
    throw error;
  }
}
