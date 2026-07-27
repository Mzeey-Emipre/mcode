import { defineConfig } from "vitest/config";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();
const serverPackageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      MCODE_DATA_DIR: testDataDir,
      MCODE_DRIZZLE_MIGRATIONS_DIR: resolve(serverPackageRoot, "drizzle"),
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
  },
});
