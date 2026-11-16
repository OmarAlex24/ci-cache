import { Hono, type Context } from "hono";

import { badRequest, forbidden, HttpError } from "../errors.ts";
import { recordCacheEvent } from "../metrics/record.ts";
import { requireSession } from "../session/middleware.ts";
import { getWithFallback, readResult, tierLayout } from "../storage/tiers.ts";
import { putStreaming, writablePrefix } from "../storage/upload.ts";
import { timer } from "../timing.ts";
import type { AppEnv } from "../types.ts";

// Minimal WebDAV for sccache 0.19's `webdav` backend (OpenDAL). It only implements
// what sccache asked for in real tests (see the README):
//   GET      /dav/<path>  reads (with branch → main/ fallback)
//   PUT      /dav/<path>  writes to the session's prefix
//   PROPFIND /dav/<dir>/  Depth: 0, before writing, to check that the directory exists
// R2 has no directories, so every directory "exists" and sccache never sends MKCOL.

export const DAV_PREFIX = "/dav";
const META_WRITER = "writer-kind";
// Segments like `.sccache_check`, `8`, `8efb...`; no `.` or `..`.
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/u;
const MAX_PATH = 512;
/** Probe object sccache reads and writes at startup: not counted in metrics. */
const CHECK_OBJECT = ".sccache_check";

/**
 * Validated relative path under /dav. Tolerates repeated slashes (sccache sends `/dav//x`
 * if SCCACHE_WEBDAV_ENDPOINT ends in `/`).
 */
export function parseDavPath(pathname: string): { path: string; isDir: boolean } {
  const rest = pathname.slice(DAV_PREFIX.length);
  if (rest !== "" && !rest.startsWith("/")) throw badRequest("Invalid path");
  if (rest.length > MAX_PATH) throw badRequest("Path too long");
  const segments = rest.split("/").filter((segment) => segment !== "");
  if (!segments.every((segment) => SEGMENT.test(segment))) throw badRequest("Invalid path");
  return { path: segments.join("/"), isDir: segments.length === 0 || rest.endsWith("/") };
}

const davPath = (c: Context<AppEnv>) => parseDavPath(new URL(c.req.url).pathname);

const directoryPropfind = (href: string) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:multistatus xmlns:D="DAV:"><D:response>' +
  `<D:href>${href}</D:href>` +
  "<D:propstat><D:prop>" +
  "<D:resourcetype><D:collection/></D:resourcetype>" +
  // OpenDAL requires getlastmodified; for a virtual directory any value works.
  `<D:getlastmodified>${new Date(0).toUTCString()}</D:getlastmodified>` +
  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
  "</D:response></D:multistatus>";

export function davRoutes() {
  const app = new Hono<AppEnv>();
  const paths = [DAV_PREFIX, `${DAV_PREFIX}/*`];
  for (const path of paths) app.use(path, requireSession);

  const layoutOf = (c: Context<AppEnv>) => tierLayout(c.get("session"), "sccache");

  // Hono serves HEAD with this same handler and drops the body.
  app.get(`${DAV_PREFIX}/*`, async (c) => {
    const { path, isDir } = davPath(c);
    if (isDir) throw new HttpError(404, "not_found", "Not found");
    const hit = await getWithFallback(c.env.CACHE, await layoutOf(c), path, timer(c));
    if (path !== CHECK_OBJECT && c.req.method === "GET") {
      recordCacheEvent(c, {
        protocol: "sccache",
        result: hit ? readResult(c.get("session"), hit.source) : "miss",
        writerKind: hit?.object.customMetadata?.[META_WRITER] ?? "",
        bytes: hit?.object.size ?? 0,
        durationMs: 0,
      });
    }
    if (!hit) throw new HttpError(404, "not_found", "Not found");
    return c.body(hit.object.body, 200, {
      "content-type": "application/octet-stream",
      "content-length": String(hit.object.size),
    });
  });

  app.put(`${DAV_PREFIX}/*`, async (c) => {
    const { path, isDir } = davPath(c);
    if (isDir) throw badRequest("Invalid path");
    const prefix = writablePrefix(await layoutOf(c));
    const kind = c.get("session").kind;
    const object = await timer(c)("r2-put", () => putStreaming(c, prefix + path, { [META_WRITER]: kind }));
    if (path !== CHECK_OBJECT) {
      recordCacheEvent(c, { protocol: "sccache", result: "write", writerKind: kind, bytes: object.size, durationMs: 0 });
    }
    return c.body(null, 201);
  });

  app.on("PROPFIND", paths, (c) => {
    const { isDir } = davPath(c);
    // No listings: only Depth 0 and only on directories.
    if (c.req.header("depth") !== "0") throw forbidden("Only Depth: 0 is supported");
    if (!isDir) throw new HttpError(404, "not_found", "Not found");
    return c.body(directoryPropfind(new URL(c.req.url).pathname), 207, {
      "content-type": "application/xml; charset=utf-8",
    });
  });

  app.all(`${DAV_PREFIX}/*`, () => {
    throw new HttpError(405, "method_not_allowed", "Method not supported");
  });

  return app;
}
