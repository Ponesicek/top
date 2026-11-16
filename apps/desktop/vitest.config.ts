import { defineConfig } from "vitest/config";

// Its own config, so the tests don't load the app's Vite plugins (React, Tailwind).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
