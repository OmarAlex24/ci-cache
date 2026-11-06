import type { Env } from "./env.ts";
import { HttpError } from "./errors.ts";

export interface Config {
  audience: string;
  allowedOwners: ReadonlySet<string>;
  mainWriteEvents: ReadonlySet<string>;
  mainRefs: ReadonlySet<string>;
  sessionTtlSeconds: number;
}

const DEFAULT_MAIN_WRITE_EVENTS = "push";
const DEFAULT_MAIN_REFS = "refs/heads/main,refs/heads/master";
const DEFAULT_SESSION_TTL_SECONDS = 6 * 60 * 60;
export const MIN_SESSION_SECRET_LENGTH = 32;

function list(value: string | undefined, fallback: string, lowercase = false): Set<string> {
  const raw = value === undefined || value.trim() === "" ? fallback : value;
  return new Set(
    raw
      .split(",")
      .map((item) => (lowercase ? item.trim().toLowerCase() : item.trim()))
      .filter((item) => item !== ""),
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw misconfigured();
  return parsed;
}

const misconfigured = () => new HttpError(500, "misconfigured", "El servicio no está configurado");

export function readConfig(env: Env): Config {
  if (!env.CACHE_AUDIENCE) throw misconfigured();
  return {
    audience: env.CACHE_AUDIENCE,
    allowedOwners: list(env.ALLOWED_OWNERS, "", true),
    mainWriteEvents: list(env.MAIN_WRITE_EVENTS, DEFAULT_MAIN_WRITE_EVENTS),
    mainRefs: list(env.MAIN_REFS, DEFAULT_MAIN_REFS),
    sessionTtlSeconds: positiveInt(env.SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
  };
}

export function readSessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) throw misconfigured();
  return secret;
}
