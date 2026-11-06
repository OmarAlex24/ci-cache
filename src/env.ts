/** Bindings, vars y secrets del Worker. Ver README para la lista completa. */
export interface Env {
  /** Bucket R2 con la caché. */
  CACHE: R2Bucket;

  /** Secret: llave HMAC de los tokens de sesión (≥ 32 caracteres). */
  SESSION_SECRET: string;
  /** Secret: JSON `{ "<sha256 hex de la llave>": { repoId, repo, label } }`. */
  SANDBOX_KEYS?: string;

  CACHE_AUDIENCE: string;
  ALLOWED_OWNERS: string;
  MAIN_WRITE_EVENTS?: string;
  MAIN_REFS?: string;
  SESSION_TTL_SECONDS?: string;
}

declare global {
  namespace Cloudflare {
    // Para que `env` de "cloudflare:workers" (pruebas) tenga el tipo del Worker.
    interface Env extends WorkerEnv {}
  }
}
type WorkerEnv = Env;
