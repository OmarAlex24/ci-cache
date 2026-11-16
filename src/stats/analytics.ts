import type { Env } from "../env.ts";
import { HttpError } from "../errors.ts";

/** SQL query to Analytics Engine. An interface so it can be tested without network. */
export interface AnalyticsClient {
  query(sql: string): Promise<Record<string, unknown>[]>;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const unavailable = () => new HttpError(502, "analytics_unavailable", "Could not query the metrics");

/** Analytics Engine SQL API client (POST /accounts/:id/analytics_engine/sql). */
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
        // Only the status: the body may echo the query or account data.
        console.error("Analytics Engine responded", response.status);
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
    throw new HttpError(503, "metrics_not_configured", "Metrics are not configured");
  }
  return cloudflareAnalytics(accountId, token);
}
