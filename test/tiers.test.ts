import { describe, expect, it } from "vitest";

import { getWithFallback, type TierLayout } from "../src/storage/tiers.ts";

const layout: TierLayout = {
  write: "ramas/1/abc/sccache/",
  read: [
    { prefix: "ramas/1/abc/sccache/", source: "own" },
    { prefix: "main/1/sccache/", source: "main" },
  ],
};

/** Bucket falso: cada get queda pendiente hasta que la prueba lo resuelve. */
function fakeBucket(objects: Record<string, string>) {
  const calls: { key: string; resolve: () => void }[] = [];
  const cancelled: string[] = [];
  const bucket = {
    get(key: string) {
      return new Promise((resolve) => {
        calls.push({
          key,
          resolve: () => {
            if (!(key in objects)) return resolve(null);
            const body = new ReadableStream({ cancel: () => void cancelled.push(key) });
            resolve({ key, body, size: objects[key]!.length });
          },
        });
      });
    },
  } as unknown as R2Bucket;
  return { bucket, calls, cancelled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("getWithFallback", () => {
  it("lee la rama y main/ a la vez (una ida y vuelta a R2, no dos)", async () => {
    const { bucket, calls } = fakeBucket({ "main/1/sccache/x": "m" });
    const result = getWithFallback(bucket, layout, "x");
    await tick();
    expect(calls.map((call) => call.key)).toEqual(["ramas/1/abc/sccache/x", "main/1/sccache/x"]);
    calls[1]!.resolve();
    calls[0]!.resolve();
    expect((await result)?.source).toBe("main");
  });

  it("prefiere la rama aunque main/ responda antes, y suelta el cuerpo de main/", async () => {
    const { bucket, calls, cancelled } = fakeBucket({ "ramas/1/abc/sccache/x": "r", "main/1/sccache/x": "m" });
    const result = getWithFallback(bucket, layout, "x");
    await tick();
    calls[1]!.resolve();
    await tick();
    calls[0]!.resolve();
    const hit = await result;
    expect(hit?.source).toBe("own");
    expect(hit?.object).toMatchObject({ key: "ramas/1/abc/sccache/x" });
    await tick();
    expect(cancelled).toEqual(["main/1/sccache/x"]);
  });

  it("si la rama no está y main/ tampoco, null", async () => {
    const { bucket, calls } = fakeBucket({});
    const result = getWithFallback(bucket, layout, "x");
    await tick();
    for (const call of calls) call.resolve();
    expect(await result).toBeNull();
  });
});
