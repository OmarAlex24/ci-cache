import type { Env } from "../env.ts";
import { HttpError } from "../errors.ts";

/** Consulta SQL a Analytics Engine. Interfaz para poder probar sin red. */
export interface AnalyticsClient {
  query(sql: string): Promise<Record<string, unknown>[]>;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const unavailable = () => new HttpError(502, "analytics_unavailable", "No se pudieron consultar las métricas");

/** Cliente de la API SQL de Analytics Engine (POST /accounts/:id/analytics_engine/sql). */
export function cloudflareAnalytics(accountId: string, apiToken: string, fetcher: typeof fetch = fetch): AnalyticsClient {
  return {
    async query(sql) {
      let response: Response;
      try {
        response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiToken}`, "content-type": "text/plain" },
          body: sql,
        });
      } catch {
        throw unavailable();
      }
      if (!response.ok) {
        // Solo el estado: el cuerpo puede repetir la consulta o datos de la cuenta.
        console.error("Analytics Engine respondió", response.status);
        throw unavailable();
      }
      const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
      if (!body || !Array.isArray(body.data)) throw unavailable();
      return body.data as Record<string, unknown>[];
    },
  };
}

export function analyticsFromEnv(env: Env): AnalyticsClient {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_API_TOKEN;
  if (!accountId || !ACCOUNT_ID.test(accountId) || !token) {
    throw new HttpError(503, "metrics_not_configured", "Las métricas no están configuradas");
  }
  return cloudflareAnalytics(accountId, token);
}
