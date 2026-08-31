import { defineConfig } from "vitest/config";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();
const serverPackageRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    // Electron child processes are heavier than Node's. Two workers keep Windows
    // process-integration tests within their timing bounds without serializing the suite.
    maxWorkers: 2,
    env: {
      MCODE_DATA_DIR: testDataDir,
      MCODE_DRIZZLE_MIGRATIONS_DIR: NodePath.resolve(serverPackageRoot, "drizzle"),
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
  },
});
