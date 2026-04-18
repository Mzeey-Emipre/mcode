import { defineConfig } from "vitest/config";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/main/__tests__/**/*.test.ts"],
    env: {
      MCODE_DATA_DIR: testDataDir,
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/main/**/*.ts"],
      exclude: ["src/main/__tests__/**", "src/preload/**"],
    },
  },
});
