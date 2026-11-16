/** The Worker's bindings, vars and secrets. See the README for the full list. */
export interface Env {
  /** R2 bucket holding the cache. */
  CACHE: R2Bucket;
  /** Workers Analytics Engine: one data point per cache request. */
  METRICS?: AnalyticsEngineDataset;

  /** Secret: HMAC key for session tokens (≥ 32 characters). */
  SESSION_SECRET: string;
  /** Secret: JSON `{ "<sha256 hex of the key>": { repoId, repo, label } }`. */
  SANDBOX_KEYS?: string;
  /** Secret: JSON `{ "<sha256 hex of the key>": { label, repoIds? } }`, read-only keys for /v1/stats. */
  STATS_KEYS?: string;
  /** Secret: Cloudflare account for the Analytics Engine SQL API. */
  CF_ACCOUNT_ID?: string;
  /** Secret: API token with the "Account Analytics: Read" permission. */
  CF_API_TOKEN?: string;

  CACHE_AUDIENCE: string;
  ALLOWED_OWNERS: string;
  MAIN_WRITE_EVENTS?: string;
  MAIN_REFS?: string;
  SESSION_TTL_SECONDS?: string;
  MAX_ARTIFACT_BYTES?: string;
  /** Analytics Engine dataset name (the same as in the METRICS binding). */
  METRICS_DATASET?: string;
  /** Sandbox writes on a branch from which an alert is raised if CI reused none of them. */
  REUSE_ALERT_MIN_WRITES?: string;
}

declare global {
  namespace Cloudflare {
    // So that `env` from "cloudflare:workers" (tests) has the Worker's type.
    interface Env extends WorkerEnv {}
  }
}
type WorkerEnv = Env;
