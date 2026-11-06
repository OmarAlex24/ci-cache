import type { Context } from "hono";

import { readConfig } from "../config.ts";
import { forbidden, HttpError } from "../errors.ts";
import type { AppEnv } from "../types.ts";
import type { TierLayout } from "./tiers.ts";

const DECIMAL = /^[0-9]{1,15}$/u;

/** Prefijo de escritura de la sesión o 403 si es de solo lectura (main-ro). */
export function writablePrefix(layout: TierLayout): string {
  if (layout.write === null) throw forbidden("Este token solo puede leer main/");
  return layout.write;
}

/**
 * Sube el cuerpo a R2 en streaming, sin cargarlo en memoria. Exige `content-length`
 * (R2 necesita la longitud del stream) y respeta el tope configurable.
 */
export async function putStreaming(
  c: Context<AppEnv>,
  key: string,
  customMetadata: Record<string, string>,
): Promise<R2Object> {
  const declared = c.req.header("content-length");
  if (declared === undefined || !DECIMAL.test(declared)) {
    throw new HttpError(411, "length_required", "Falta content-length");
  }
  const length = Number(declared);
  if (length > readConfig(c.env).maxArtifactBytes) {
    throw new HttpError(413, "payload_too_large", "El objeto supera el tamaño máximo");
  }
  const body = c.req.raw.body ?? new Uint8Array(0);
  const object = await c.env.CACHE.put(key, length === 0 ? new Uint8Array(0) : body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata,
  });
  if (!object) throw new HttpError(500, "internal_error", "Error interno");
  return object;
}
