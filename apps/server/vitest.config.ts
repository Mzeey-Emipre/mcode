import { defineConfig } from "vitest/config";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Create a per-run temp dir so tests cannot touch the developer's real
// ~/.mcode or ~/.mcode-dev (which is shared with `bun run dev`). This is
// what prevented the unclean server restart in issue #290: vitest and the
// live server were both writing to the same log + sqlite files.
const testDataDir = mkdtempSync(join(tmpdir(), "mcode-test-"));
// Mirror into process.env so the shared globalSetup teardown can locate
// and remove the dir after the run; workers still receive it via test.env.
process.env.MCODE_DATA_DIR = testDataDir;

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
