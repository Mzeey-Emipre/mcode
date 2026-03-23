import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/main/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/main/**/*.ts"],
      exclude: ["src/main/__tests__/**", "src/preload/**"],
    },
  },
});
