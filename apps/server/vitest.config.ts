import { defineConfig } from "vitest/config";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      MCODE_DATA_DIR: testDataDir,
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
  },
});
