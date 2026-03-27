/**
 * Centralized Mcode data directory resolution.
 * Reads the MCODE_DATA_DIR environment variable, falling back to
 * `~/.mcode` (production) or `~/.mcode-dev` (development).
 */

import { join } from "path";
import { homedir } from "os";

const MCODE_DIR_NAME =
  process.env.NODE_ENV !== "production" ? ".mcode-dev" : ".mcode";

/**
 * Resolve the absolute path to the Mcode data directory.
 * Prefers the `MCODE_DATA_DIR` env var when set, otherwise falls back
 * to `~/.mcode` (production) or `~/.mcode-dev` (development).
 */
export function getMcodeDir(): string {
  return process.env.MCODE_DATA_DIR ?? join(homedir(), MCODE_DIR_NAME);
}
