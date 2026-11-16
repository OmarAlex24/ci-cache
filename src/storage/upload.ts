import type { Context } from "hono";

import { readConfig } from "../config.ts";
import { forbidden, HttpError } from "../errors.ts";
import type { AppEnv } from "../types.ts";
import type { TierLayout } from "./tiers.ts";

const DECIMAL = /^[0-9]{1,15}$/u;

/** The session's write prefix, or 403 if it is read-only (main-ro). */
export function writablePrefix(layout: TierLayout): string {
  if (layout.write === null) throw forbidden("This token can only read main/");
  return layout.write;
}

/**
 * Streams the body to R2 without loading it into memory. Requires `content-length`
 * (R2 needs the stream's length) and enforces the configurable cap.
 */
export async function putStreaming(
  c: Context<AppEnv>,
  key: string,
  customMetadata: Record<string, string>,
): Promise<R2Object> {
  const declared = c.req.header("content-length");
  if (declared === undefined || !DECIMAL.test(declared)) {
    throw new HttpError(411, "length_required", "Missing content-length");
  }
  const length = Number(declared);
  if (length > readConfig(c.env).maxArtifactBytes) {
    throw new HttpError(413, "payload_too_large", "The object exceeds the maximum size");
  }
  const body = c.req.raw.body ?? new Uint8Array(0);
  const object = await c.env.CACHE.put(key, length === 0 ? new Uint8Array(0) : body, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata,
  });
  if (!object) throw new HttpError(500, "internal_error", "Internal error");
  return object;
}
