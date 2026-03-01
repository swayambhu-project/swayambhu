import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": path.resolve("__mocks__/cloudflare-workers.js"),
    },
  },
});
