/**
 * Tracks environment variable keys owned by the Mcode server process so they
 * are never replaced by values from the user's shell or Windows registry.
 */

import { injectable } from "tsyringe";

const AUTO_PROTECT_PREFIXES = ["MCODE_", "ELECTRON_", "BETTER_SQLITE3_"] as const;

/**
 * Holds a snapshot of server-owned env values and merges them over resolved
 * child-process environments so spawns keep a stable runtime contract.
 */
@injectable()
export class ProtectedEnvStore {
  private readonly explicitKeys = new Set<string>();
  private readonly snapshot: Record<string, string>;

  constructor() {
    this.snapshot = {};
    this.captureFromProcessEnv();
  }

  /**
   * Declares a key as server-owned when it does not match an auto-protected prefix
   * (e.g. a future internal variable with no prefix).
   */
  protect(key: string): void {
    this.explicitKeys.add(key);
    const v = process.env[key];
    if (v !== undefined) {
      this.snapshot[key] = v;
    }
  }

  /**
   * Returns whether a key is treated as owned by the server (prefix or explicit).
   */
  isProtected(key: string): boolean {
    for (const prefix of AUTO_PROTECT_PREFIXES) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return this.explicitKeys.has(key);
  }

  /**
   * Drops protected names from the resolved map, then overlays the snapshotted
   * server values so shell or registry cannot set server-owned keys.
   */
  applyTo(resolved: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = { ...resolved };
    for (const key of Object.keys(out)) {
      if (this.isProtected(key)) {
        delete out[key];
      }
    }
    return { ...out, ...this.snapshot };
  }

  private captureFromProcessEnv(): void {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && this.isProtected(key)) {
        this.snapshot[key] = value;
      }
    }
  }
}
