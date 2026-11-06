import type { Context } from "hono";

import { badRequest, HttpError } from "./errors.ts";

const BEARER = /^Bearer ([\x21-\x7e]{1,4096})$/u;

/** Devuelve el token de `Authorization: Bearer ...` o null. Nunca lo registra. */
export function readBearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}

/** Lee un cuerpo JSON pequeño con tope de bytes. */
export async function readSmallJson(c: Context, maxBytes: number): Promise<unknown> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Cuerpo demasiado grande");
  }
  const text = await c.req.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large", "Cuerpo demasiado grande");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("El cuerpo debe ser JSON válido");
  }
}
