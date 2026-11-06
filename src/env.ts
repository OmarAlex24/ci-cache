/** Bindings, vars y secrets del Worker. Ver README para la lista completa. */
export interface Env {
  /** Bucket R2 con la caché. */
  CACHE: R2Bucket;
  /** Workers Analytics Engine: un punto por petición de caché. */
  METRICS?: AnalyticsEngineDataset;

  /** Secret: llave HMAC de los tokens de sesión (≥ 32 caracteres). */
  SESSION_SECRET: string;
  /** Secret: JSON `{ "<sha256 hex de la llave>": { repoId, repo, label } }`. */
  SANDBOX_KEYS?: string;
  /** Secret: JSON `{ "<sha256 hex de la llave>": { label, repoIds? } }`, llaves de solo lectura de /v1/stats. */
  STATS_KEYS?: string;
  /** Secret: cuenta de Cloudflare para la API SQL de Analytics Engine. */
  CF_ACCOUNT_ID?: string;
  /** Secret: token de API con permiso "Account Analytics: Read". */
  CF_API_TOKEN?: string;

  CACHE_AUDIENCE: string;
  ALLOWED_OWNERS: string;
  MAIN_WRITE_EVENTS?: string;
  MAIN_REFS?: string;
  SESSION_TTL_SECONDS?: string;
  MAX_ARTIFACT_BYTES?: string;
  /** Nombre del dataset de Analytics Engine (el mismo que en el binding METRICS). */
  METRICS_DATASET?: string;
  /** Escrituras del sandbox en una rama a partir de las cuales se avisa si la CI no reutilizó ninguna. */
  REUSE_ALERT_MIN_WRITES?: string;
}

declare global {
  namespace Cloudflare {
    // Para que `env` de "cloudflare:workers" (pruebas) tenga el tipo del Worker.
    interface Env extends WorkerEnv {}
  }
}
type WorkerEnv = Env;
