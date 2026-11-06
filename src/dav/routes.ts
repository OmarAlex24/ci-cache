import { Hono, type Context } from "hono";

import { badRequest, forbidden, HttpError } from "../errors.ts";
import { recordCacheEvent } from "../metrics/record.ts";
import { requireSession } from "../session/middleware.ts";
import { getWithFallback, readResult, tierLayout } from "../storage/tiers.ts";
import { putStreaming, writablePrefix } from "../storage/upload.ts";
import type { AppEnv } from "../types.ts";

// WebDAV mínimo para el backend `webdav` de sccache 0.19 (OpenDAL). Solo implementa
// lo que sccache pidió en las pruebas reales (ver README):
//   GET      /dav/<ruta>  lee (con fallback rama → main/)
//   PUT      /dav/<ruta>  escribe en el prefijo de la sesión
//   PROPFIND /dav/<dir>/  Depth: 0, antes de escribir, para saber si el directorio existe
// R2 no tiene directorios, así que todo directorio "existe" y sccache nunca manda MKCOL.

export const DAV_PREFIX = "/dav";
const META_WRITER = "writer-kind";
// Segmentos tipo `.sccache_check`, `8`, `8efb...`; sin `.` ni `..`.
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/u;
const MAX_PATH = 512;
/** Objeto de prueba que sccache lee y escribe al arrancar: no cuenta en las métricas. */
const CHECK_OBJECT = ".sccache_check";

/**
 * Ruta relativa bajo /dav validada. Tolera barras repetidas (sccache manda `/dav//x`
 * si SCCACHE_WEBDAV_ENDPOINT termina en `/`).
 */
export function parseDavPath(pathname: string): { path: string; isDir: boolean } {
  const rest = pathname.slice(DAV_PREFIX.length);
  if (rest !== "" && !rest.startsWith("/")) throw badRequest("Ruta inválida");
  if (rest.length > MAX_PATH) throw badRequest("Ruta demasiado larga");
  const segments = rest.split("/").filter((segment) => segment !== "");
  if (!segments.every((segment) => SEGMENT.test(segment))) throw badRequest("Ruta inválida");
  return { path: segments.join("/"), isDir: segments.length === 0 || rest.endsWith("/") };
}

const davPath = (c: Context<AppEnv>) => parseDavPath(new URL(c.req.url).pathname);

const directoryPropfind = (href: string) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<D:multistatus xmlns:D="DAV:"><D:response>' +
  `<D:href>${href}</D:href>` +
  "<D:propstat><D:prop>" +
  "<D:resourcetype><D:collection/></D:resourcetype>" +
  // OpenDAL exige getlastmodified; para un directorio virtual da igual cuál.
  `<D:getlastmodified>${new Date(0).toUTCString()}</D:getlastmodified>` +
  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
  "</D:response></D:multistatus>";

export function davRoutes() {
  const app = new Hono<AppEnv>();
  const paths = [DAV_PREFIX, `${DAV_PREFIX}/*`];
  for (const path of paths) app.use(path, requireSession);

  const layoutOf = (c: Context<AppEnv>) => tierLayout(c.get("session"), "sccache");

  // Hono atiende HEAD con este mismo handler y descarta el cuerpo.
  app.get(`${DAV_PREFIX}/*`, async (c) => {
    const { path, isDir } = davPath(c);
    if (isDir) throw new HttpError(404, "not_found", "No encontrado");
    const hit = await getWithFallback(c.env.CACHE, await layoutOf(c), path);
    if (path !== CHECK_OBJECT && c.req.method === "GET") {
      recordCacheEvent(c, {
        protocol: "sccache",
        result: hit ? readResult(c.get("session"), hit.source) : "miss",
        writerKind: hit?.object.customMetadata?.[META_WRITER] ?? "",
        bytes: hit?.object.size ?? 0,
        durationMs: 0,
      });
    }
    if (!hit) throw new HttpError(404, "not_found", "No encontrado");
    return c.body(hit.object.body, 200, {
      "content-type": "application/octet-stream",
      "content-length": String(hit.object.size),
    });
  });

  app.put(`${DAV_PREFIX}/*`, async (c) => {
    const { path, isDir } = davPath(c);
    if (isDir) throw badRequest("Ruta inválida");
    const prefix = writablePrefix(await layoutOf(c));
    const kind = c.get("session").kind;
    const object = await putStreaming(c, prefix + path, { [META_WRITER]: kind });
    if (path !== CHECK_OBJECT) {
      recordCacheEvent(c, { protocol: "sccache", result: "write", writerKind: kind, bytes: object.size, durationMs: 0 });
    }
    return c.body(null, 201);
  });

  app.on("PROPFIND", paths, (c) => {
    const { isDir } = davPath(c);
    // Sin listados: solo Depth 0 y solo sobre directorios.
    if (c.req.header("depth") !== "0") throw forbidden("Solo se admite Depth: 0");
    if (!isDir) throw new HttpError(404, "not_found", "No encontrado");
    return c.body(directoryPropfind(new URL(c.req.url).pathname), 207, {
      "content-type": "application/xml; charset=utf-8",
    });
  });

  app.all(`${DAV_PREFIX}/*`, () => {
    throw new HttpError(405, "method_not_allowed", "Método no soportado");
  });

  return app;
}
