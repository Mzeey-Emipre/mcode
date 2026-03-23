/**
 * Centralized Mcode data directory path.
 *
 * Dev builds use ~/.mcode-dev/ so they never collide with production data.
 */

import { join } from "path";
import { homedir } from "os";

const MCODE_DIR_NAME = import.meta.env.DEV ? ".mcode-dev" : ".mcode";

/** Absolute path to the Mcode data directory (e.g. ~/.mcode or ~/.mcode-dev). */
export const MCODE_DIR = join(homedir(), MCODE_DIR_NAME);
