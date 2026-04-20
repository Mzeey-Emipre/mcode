/**
 * Shared Vitest global setup: remove the per-run MCODE_DATA_DIR temp dir
 * after tests finish. The dir itself is created in each package's
 * vitest.config.ts (so the env var is available at config-load time); this
 * teardown prevents the accumulation that would otherwise leave a fresh
 * `mcode-test-XXXX` directory behind every time `bun run test` runs.
 */

import { rmSync } from "fs";

export default function setup(): () => void {
  return () => {
    const dir = process.env.MCODE_DATA_DIR;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; CI runners will evict temp dirs on reboot anyway.
    }
  };
}
