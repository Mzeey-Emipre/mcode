import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { createTestDataDir } from "../../scripts/vitest-test-dir";

const testDataDir = createTestDataDir();
const webSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../web/src");

export default defineConfig({
  resolve: { alias: { "@": webSourceRoot } },
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/main/__tests__/**/*.test.ts",
      "src/features/**/__tests__/**/*.test.ts",
      "scripts/__tests__/**/*.test.{ts,mjs,js}",
    ],
    env: {
      MCODE_DATA_DIR: testDataDir,
    },
    globalSetup: ["../../scripts/vitest-global-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/main/**/*.ts", "src/features/**/*.ts"],
      exclude: ["src/main/__tests__/**", "src/features/**/__tests__/**", "src/preload/**"],
    },
  },
});
