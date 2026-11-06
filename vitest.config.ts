import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { TEST_BINDINGS } from "./test/bindings.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: TEST_BINDINGS },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
