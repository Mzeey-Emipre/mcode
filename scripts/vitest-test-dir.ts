/**
 * Shared helper for vitest.config.ts files across the monorepo.
 *
 * Creates a per-run temp dir and sets MCODE_DATA_DIR so tests cannot touch
 * the developer's real ~/.mcode or ~/.mcode-dev (which is shared with
 * `bun run dev`). This is what prevented the unclean server restart in
 * issue #290: vitest and the live server were both writing to the same
 * log + sqlite files.
 *
 * Each vitest config module loads independently, so each call creates its
 * own temp dir. The shared `vitest-global-setup.ts` removes it after the
 * run completes.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Creates a unique per-run test data directory and sets `MCODE_DATA_DIR`. */
export function createTestDataDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-test-"));
  // Mirror into process.env so the shared globalSetup teardown can locate
  // and remove the dir after the run; workers still receive it via test.env.
  process.env.MCODE_DATA_DIR = dir;
  return dir;
}
