import { describe, expect, it } from "vitest";

import { getWithFallback, headWithFallback, type TierLayout } from "../src/storage/tiers.ts";
import { untimed } from "../src/timing.ts";

const layout: TierLayout = {
  write: "ramas/1/abc/sccache/",
  read: [
    { prefix: "ramas/1/abc/sccache/", source: "own" },
    { prefix: "main/1/sccache/", source: "main" },
  ],
};

/** Fake bucket: each get stays pending until the test resolves it. */
function fakeBucket(objects: Record<string, string>) {
  const calls: { key: string; resolve: () => void }[] = [];
  const cancelled: string[] = [];
  const pendingRead = (key: string) =>
    new Promise((resolve) => {
      calls.push({ key, resolve: () => resolve(key in objects ? { key } : null) });
    });
  const bucket = {
    head: pendingRead,
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
  it("reads the branch and main/ concurrently (one R2 round trip, not two)", async () => {
    const { bucket, calls } = fakeBucket({ "main/1/sccache/x": "m" });
    const result = getWithFallback(bucket, layout, "x");
    await tick();
    expect(calls.map((call) => call.key)).toEqual(["ramas/1/abc/sccache/x", "main/1/sccache/x"]);
    calls[1]!.resolve();
    calls[0]!.resolve();
    expect((await result)?.source).toBe("main");
  });

  it("prefers the branch even if main/ answers first, and releases main/'s body", async () => {
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

  it("null if neither the branch nor main/ has it", async () => {
    const { bucket, calls } = fakeBucket({});
    const result = getWithFallback(bucket, layout, "x");
    await tick();
    for (const call of calls) call.resolve();
    expect(await result).toBeNull();
  });
});

describe("sequential headWithFallback (Turbo batch query)", () => {
  it("only asks main/ if the branch doesn't have it", async () => {
    const { bucket, calls } = fakeBucket({ "main/1/sccache/x": "m" });
    const result = headWithFallback(bucket, layout, "x", untimed, false);
    await tick();
    expect(calls.map((call) => call.key)).toEqual(["ramas/1/abc/sccache/x"]);
    calls[0]!.resolve();
    await tick();
    expect(calls.map((call) => call.key)).toEqual(["ramas/1/abc/sccache/x", "main/1/sccache/x"]);
    calls[1]!.resolve();
    expect((await result)?.source).toBe("main");
  });

  it("a branch hit makes a single operation", async () => {
    const { bucket, calls } = fakeBucket({ "ramas/1/abc/sccache/x": "r" });
    const result = headWithFallback(bucket, layout, "x", untimed, false);
    await tick();
    calls[0]!.resolve();
    expect((await result)?.source).toBe("own");
    expect(calls).toHaveLength(1);
  });
});
