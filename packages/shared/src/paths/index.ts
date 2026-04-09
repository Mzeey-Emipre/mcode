/**
 * Centralized Mcode data directory resolution.
 * Reads the MCODE_DATA_DIR environment variable, falling back to
 * `~/.mcode` (production) or `~/.mcode-dev` (development).
 */

import { join } from "path";
import { homedir } from "os";

/**
 * Resolve the absolute path to the Mcode data directory.
 * Prefers the `MCODE_DATA_DIR` env var when set, otherwise falls back
 * to `~/.mcode` (production) or `~/.mcode-dev` (development).
 *
 * The dir name is evaluated at call time (not import time) so that
 * callers can set NODE_ENV before the first invocation.
 */
export function getMcodeDir(): string {
  if (process.env.MCODE_DATA_DIR) return process.env.MCODE_DATA_DIR;
  const dirName =
    process.env.NODE_ENV !== "production" ? ".mcode-dev" : ".mcode";
  return join(homedir(), dirName);
}
