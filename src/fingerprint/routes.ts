import { Hono } from "hono";

import { badRequest, forbidden, HttpError } from "../errors.ts";
import { requireSession } from "../session/middleware.ts";
import { counterpartFingerprints, ownFingerprintKey } from "../storage/tiers.ts";
import { timer } from "../timing.ts";
import type { AppEnv } from "../types.ts";

// Cache fingerprints (the output of scripts/cache-fingerprint.sh): the sandbox uploads its
// own after getting a session, and the branch's CI downloads it to compare it with its own
// and say which line would make the cache miss (setup/fingerprint-compare.sh).
//   PUT /v1/fingerprint  stores the session's fingerprint under its own tier prefix
//   GET /v1/fingerprint  returns the counterpart (CI on a branch → that branch's sandbox)
// One object per (tier, repo, branch, kind): no listings, no way to name another branch.

export const MAX_FINGERPRINT_BYTES = 64 * 1024;
const DECIMAL = /^[0-9]{1,15}$/u;
const tooLarge = () => new HttpError(413, "payload_too_large", "The fingerprint exceeds 64 KB");

export function fingerprintRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/v1/fingerprint", requireSession);

  app.put("/v1/fingerprint", async (c) => {
    const key = await ownFingerprintKey(c.get("session"));
    if (key === null) throw forbidden("This token can only read main/");
    const declared = c.req.header("content-length");
    if (declared !== undefined && (!DECIMAL.test(declared) || Number(declared) > MAX_FINGERPRINT_BYTES)) {
      throw tooLarge();
    }
    // The real size counts, not the declared one (a chunked body has no content-length).
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_FINGERPRINT_BYTES) throw tooLarge();
    if (body.byteLength === 0) throw badRequest("Empty fingerprint");
    await timer(c)("r2-put", () =>
      c.env.CACHE.put(key, body, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }),
    );
    return c.body(null, 204);
  });

  app.get("/v1/fingerprint", async (c) => {
    for (const { key, kind, source } of await counterpartFingerprints(c.get("session"))) {
      const object = await timer(c)(`r2-${source}`, () => c.env.CACHE.get(key));
      if (!object) continue;
      return c.body(object.body, 200, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(object.size),
        "cache-control": "no-store",
        "last-modified": object.uploaded.toUTCString(),
        // Who wrote it and from where: sandbox|ci, branch|main.
        "x-fingerprint-kind": kind,
        "x-fingerprint-source": source === "own" ? "branch" : "main",
      });
    }
    throw new HttpError(404, "not_found", "No fingerprint to compare against");
  });

  return app;
}
