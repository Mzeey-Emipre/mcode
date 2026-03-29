/**
 * User settings service.
 * Reads and writes settings.json from the Mcode data directory,
 * watches for external changes, and broadcasts updates to connected clients.
 */

import { injectable } from "tsyringe";
import { readFileSync, writeFileSync, mkdirSync, watch, existsSync } from "fs";
import { join, dirname } from "path";
import type { FSWatcher } from "fs";

import {
  SettingsSchema,
  DEFAULT_SETTINGS,
  type Settings,
  type PartialSettings,
} from "@mcode/contracts";
import { getMcodeDir, logger } from "@mcode/shared";
import { broadcast } from "../transport/push";

/**
 * Deep-merge two plain objects. Primitive values and arrays in `source`
 * overwrite those in `target`; nested plain objects are merged recursively.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = (result as Record<string, unknown>)[key];

    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }

  return result;
}

/**
 * Manages persistent user settings stored as JSON on disk.
 * Provides get/update operations with Zod validation and broadcasts
 * changes to all connected WebSocket clients.
 */
@injectable()
export class SettingsService {
  private readonly filePath: string;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the last write originated from this process (used to skip self-triggered watch events). */
  private selfWrite = false;

  constructor() {
    this.filePath = join(getMcodeDir(), "settings.json");
    this.startWatching();
  }

  /**
   * Read the current settings from disk.
   * Returns full settings with defaults applied. Never throws; returns
   * DEFAULT_SETTINGS if the file is missing or contains invalid JSON.
   */
  get(): Settings {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const result = SettingsSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
      logger.warn("Settings file failed validation, returning defaults", {
        error: result.error.message,
      });
      return DEFAULT_SETTINGS;
    } catch {
      // File doesn't exist or is not valid JSON
      return DEFAULT_SETTINGS;
    }
  }

  /**
   * Deep-merge a partial settings object into the current settings,
   * write the result to disk, and broadcast a `settings.changed` push event.
   * Returns the merged settings with defaults applied.
   */
  update(partial: PartialSettings): Settings {
    const current = this.get();
    const merged = deepMerge(
      current as unknown as Record<string, unknown>,
      partial as Record<string, unknown>,
    );

    // Validate and strip unknown keys before writing to disk
    const validated = SettingsSchema.parse(merged);

    // Ensure parent directory exists
    mkdirSync(dirname(this.filePath), { recursive: true });

    this.selfWrite = true;
    writeFileSync(this.filePath, JSON.stringify(validated, null, 2), "utf-8");
    // Safety: clear selfWrite after a window in case fs.watch never fires
    setTimeout(() => { this.selfWrite = false; }, 500);

    broadcast("settings.changed", validated);

    return validated;
  }

  /** Stop watching the settings file and clean up timers. */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Watch the settings file (or its parent directory) for external changes.
   * When the file changes, re-read and broadcast `settings.changed`.
   * Debounced at 100ms to avoid double-fires from editors that write + rename.
   */
  private startWatching(): void {
    const watchTarget = existsSync(this.filePath)
      ? this.filePath
      : dirname(this.filePath);

    try {
      this.watcher = watch(watchTarget, (_eventType, filename) => {
        // When watching the directory, only react to the settings file
        if (
          watchTarget !== this.filePath &&
          filename !== "settings.json"
        ) {
          return;
        }

        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
          // Skip events triggered by our own writes
          if (this.selfWrite) {
            this.selfWrite = false;
            return;
          }

          const settings = this.get();
          broadcast("settings.changed", settings);

          // If we started watching the directory and the file now exists,
          // switch to watching the file directly for more precise events.
          if (watchTarget !== this.filePath && existsSync(this.filePath)) {
            this.dispose();
            this.startWatching();
          }
        }, 100);
      });
    } catch (err) {
      logger.warn("Failed to watch settings file", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
