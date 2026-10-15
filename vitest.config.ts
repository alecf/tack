import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "public" },
      miniflare: { bindings: { TACK_TOKEN: "test-only-token" } },
    }),
  ],
  test: { fileParallelism: false },
});
