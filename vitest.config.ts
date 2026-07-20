import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
    globalSetup: ["apps/cli/test/global-setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
