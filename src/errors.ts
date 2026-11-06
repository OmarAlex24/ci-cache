import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Error con estado HTTP y un mensaje seguro para el cliente (sin detalles internos). */
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

export const unauthorized = () => new HttpError(401, "unauthorized", "Token ausente o inválido");
export const forbidden = (message = "Operación no permitida para este token") =>
  new HttpError(403, "forbidden", message);
export const badRequest = (message: string) => new HttpError(400, "bad_request", message);

export function jsonError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ code, message }, status);
}
