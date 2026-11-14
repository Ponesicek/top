import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test starts real daemons and kills them with SIGKILL.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
