import { Hono, type Context } from "hono";

import { badRequest, HttpError } from "../errors.ts";
import { readSmallJson } from "../http.ts";
import { requireSession } from "../session/middleware.ts";
import { headWithFallback, getWithFallback, tierLayout, type TierLayout } from "../storage/tiers.ts";
import { putStreaming, writablePrefix } from "../storage/upload.ts";
import type { AppEnv } from "../types.ts";
import type {
  ArtifactInfo,
  ArtifactQueryResponse,
  ArtifactUploadResponse,
  CacheEvent,
  CachingStatusResponse,
} from "./spec.ts";

const HASH = /^[0-9a-f]{1,128}$/iu;
const DECIMAL = /^[0-9]{1,15}$/u;
// teamId/slug se aceptan pero no deciden el prefijo (lo decide el token).
// oxlint-disable-next-line no-control-regex -- excluir controles es justo la intención
const TEAM = /^[^\x00-\x1f\x7f]{0,256}$/u;
const MAX_QUERY_HASHES = 1000;
const MAX_JSON_BYTES = 1024 * 1024;

const META_DURATION = "x-artifact-duration";
const META_TAG = "x-artifact-tag";
export const META_WRITER = "writer-kind";

function checkTeam(c: Context<AppEnv>) {
  for (const name of ["teamId", "slug"]) {
    const value = c.req.query(name);
    if (value !== undefined && !TEAM.test(value)) throw badRequest(`${name} inválido`);
  }
}

function readHash(c: Context<AppEnv>): string {
  const hash = c.req.param("hash");
  if (!hash || !HASH.test(hash)) throw badRequest("El hash del artefacto debe ser hexadecimal");
  return hash.toLowerCase();
}

function artifactHeaders(object: R2Object): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(object.size),
  };
  const meta = object.customMetadata ?? {};
  if (meta[META_DURATION] !== undefined) headers[META_DURATION] = meta[META_DURATION];
  if (meta[META_TAG] !== undefined) headers[META_TAG] = meta[META_TAG];
  return headers;
}

const notFound = () => new HttpError(404, "not_found", "Artefacto no encontrado");

export function turboRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/v8/*", requireSession);
  app.use("/v8/*", async (c, next) => {
    checkTeam(c);
    await next();
  });

  const layoutOf = (c: Context<AppEnv>): Promise<TierLayout> => tierLayout(c.get("session"), "turbo");

  app.get("/v8/artifacts/status", (c) => c.json<CachingStatusResponse>({ status: "enabled" }));

  app.post("/v8/artifacts/events", async (c) => {
    const events = await readSmallJson(c, MAX_JSON_BYTES);
    if (!Array.isArray(events) || events.length > 10_000 || !events.every(isCacheEvent)) {
      throw badRequest("Eventos inválidos");
    }
    return c.body(null, 200);
  });

  app.post("/v8/artifacts", async (c) => {
    const body = await readSmallJson(c, MAX_JSON_BYTES);
    const hashes = (body as { hashes?: unknown } | null)?.hashes;
    if (!Array.isArray(hashes) || hashes.length > MAX_QUERY_HASHES || !hashes.every((h) => typeof h === "string")) {
      throw badRequest("hashes inválidos");
    }
    const layout = await layoutOf(c);
    const unique = [...new Set(hashes as string[])];
    const found = await Promise.all(
      unique.map(async (hash): Promise<[string, ArtifactInfo | null]> => {
        if (!HASH.test(hash)) return [hash, null];
        const hit = await headWithFallback(c.env.CACHE, layout, hash.toLowerCase());
        if (!hit) return [hash, null];
        const meta = hit.object.customMetadata ?? {};
        const info: ArtifactInfo = { size: hit.object.size, taskDurationMs: Number(meta[META_DURATION] ?? 0) };
        if (meta[META_TAG] !== undefined) info.tag = meta[META_TAG];
        return [hash, info];
      }),
    );
    return c.json<ArtifactQueryResponse>(Object.fromEntries(found));
  });

  // Hono atiende HEAD con el handler de GET (y descarta el cuerpo).
  app.get("/v8/artifacts/:hash", async (c) => {
    const hash = readHash(c);
    const layout = await layoutOf(c);
    if (c.req.method === "HEAD") {
      const hit = await headWithFallback(c.env.CACHE, layout, hash);
      if (!hit) return c.body(null, 404);
      return c.body(null, 200, artifactHeaders(hit.object));
    }
    const hit = await getWithFallback(c.env.CACHE, layout, hash);
    if (!hit) throw notFound();
    return c.body(hit.object.body, 200, artifactHeaders(hit.object));
  });

  app.put("/v8/artifacts/:hash", async (c) => {
    const hash = readHash(c);
    const session = c.get("session");
    const prefix = writablePrefix(await layoutOf(c));

    const metadata: Record<string, string> = { [META_WRITER]: session.kind };
    const duration = c.req.header(META_DURATION);
    if (duration !== undefined) {
      if (!DECIMAL.test(duration)) throw badRequest("x-artifact-duration inválido");
      metadata[META_DURATION] = duration;
    }
    const tag = c.req.header(META_TAG);
    if (tag !== undefined) {
      if (tag.length > 600) throw badRequest("x-artifact-tag inválido");
      metadata[META_TAG] = tag;
    }

    await putStreaming(c, prefix + hash, metadata);
    const url = new URL(c.req.url);
    url.search = "";
    return c.json<ArtifactUploadResponse>({ urls: [url.href] }, 202);
  });

  return app;
}

function isCacheEvent(value: unknown): value is CacheEvent {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    (e.source === "LOCAL" || e.source === "REMOTE") &&
    (e.event === "HIT" || e.event === "MISS") &&
    typeof e.hash === "string" &&
    e.hash.length <= 128 &&
    (e.sessionId === undefined || (typeof e.sessionId === "string" && e.sessionId.length <= 64)) &&
    (e.duration === undefined || (typeof e.duration === "number" && Number.isInteger(e.duration) && e.duration >= 0))
  );
}
