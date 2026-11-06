import type { Env } from "./env.ts";
import { HttpError } from "./errors.ts";

export interface Config {
  audience: string;
  allowedOwners: ReadonlySet<string>;
  mainWriteEvents: ReadonlySet<string>;
  mainRefs: ReadonlySet<string>;
  sessionTtlSeconds: number;
  /** Tope por objeto en PUT. 100 MB = tope de cuerpo de un Worker (planes Free/Pro). */
  maxArtifactBytes: number;
  metricsDataset: string;
  reuseAlertMinWrites: number;
}

const DEFAULT_MAIN_WRITE_EVENTS = "push";
const DEFAULT_MAIN_REFS = "refs/heads/main,refs/heads/master";
const DEFAULT_SESSION_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DEFAULT_METRICS_DATASET = "ci_cache";
const DEFAULT_REUSE_ALERT_MIN_WRITES = 20;
const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
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

function dataset(value: string | undefined): string {
  const name = value === undefined || value.trim() === "" ? DEFAULT_METRICS_DATASET : value.trim();
  // Va dentro del SQL: solo identificadores simples.
  if (!DATASET.test(name)) throw misconfigured();
  return name;
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
    maxArtifactBytes: positiveInt(env.MAX_ARTIFACT_BYTES, DEFAULT_MAX_ARTIFACT_BYTES),
    metricsDataset: dataset(env.METRICS_DATASET),
    reuseAlertMinWrites: positiveInt(env.REUSE_ALERT_MIN_WRITES, DEFAULT_REUSE_ALERT_MIN_WRITES),
  };
}

export function readSessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SESSION_SECRET_LENGTH) throw misconfigured();
  return secret;
}
