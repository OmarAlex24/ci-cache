import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Error with an HTTP status and a message that is safe for the client (no internal details). */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized", "Missing or invalid token");
export const forbidden = (message = "Operation not allowed for this token") =>
  new HttpError(403, "forbidden", message);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);

/**
 * Error body: `{ code, message }`. Under /v8/ it is repeated as `error: { code, message }`
 * because the turbo client reads that format (Vercel's API format) and, if it is missing,
 * warns "unable to parse ... missing field `error`".
 */
export function jsonError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  const body: { code: string; message: string; error?: { code: string; message: string } } = { code, message };
  if (c.req.path.startsWith("/v8/")) body.error = { code, message };
  return c.json(body, status);
}
