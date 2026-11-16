import type { Context } from "hono";

import { badRequest, HttpError } from "./errors.ts";

const BEARER = /^Bearer ([\x21-\x7e]{1,4096})$/u;

/** Returns the token from `Authorization: Bearer ...` or null. Never logs it. */
export function readBearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}

/** Reads a small JSON body with a byte cap. */
export async function readSmallJson(c: Context, maxBytes: number): Promise<unknown> {
  const declared = c.req.header("content-length");
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Body too large");
  }
  const text = await c.req.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large", "Body too large");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("The body must be valid JSON");
  }
}
