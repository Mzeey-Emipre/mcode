/**
 * User settings service.
 * Reads and writes settings.json from the Mcode data directory,
 * watches for external changes, and broadcasts updates to connected clients.
 */

import { injectable } from "tsyringe";
import { readFileSync, writeFileSync, renameSync, mkdirSync, watch, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import type { FSWatcher } from "fs";

import {
  PartialSettingsSchema,
  SettingsSchema,
  getDefaultSettings,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeLegacyPreviewRenderingSetting(value: unknown): {
  readonly changed: boolean;
  readonly document: unknown;
} {
  if (!isRecord(value) || !isRecord(value.preview)) {
    return { changed: false, document: value };
  }

  if (!Object.prototype.hasOwnProperty.call(value.preview, "rendering")) {
    return { changed: false, document: value };
  }

  const preview = { ...value.preview };
  delete preview.rendering;
  const document = { ...value };
  if (Object.keys(preview).length === 0) {
    delete document.preview;
  } else {
    document.preview = preview;
  }
  return { changed: true, document };
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

  /** In-memory cache of the last validated settings. Populated on first read, invalidated on external change. */
  private cache: Settings | null = null;

  /** Whether the parent directory has already been created, to avoid redundant mkdirSync calls. */
  private dirEnsured = false;

  /** In-process change listeners registered via `on("change", cb)`. */
  private changeListeners: Array<(next: Settings) => void> = [];

  constructor() {
    this.filePath = join(getMcodeDir(), "settings.json");
    this.startWatching();
  }

  /**
   * Read the current settings from disk.
   * Returns the cached value if available. On cache miss, reads from disk,
   * validates, and populates the cache. Never throws; returns
   * getDefaultSettings() if the file is missing or contains invalid JSON.
   */
  get(): Settings {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const migration = removeLegacyPreviewRenderingSetting(parsed);
      const documentResult = PartialSettingsSchema().safeParse(migration.document);
      if (!documentResult.success) {
        logger.warn("Settings file failed validation, returning defaults", {
          error: documentResult.error.message,
        });
        return getDefaultSettings();
      }
      const result = SettingsSchema().safeParse(documentResult.data);
      if (result.success) {
        if (migration.changed) {
          try {
            this.writeAtomically(documentResult.data);
          } catch (error) {
            logger.warn("Failed to persist migrated settings", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.cache = result.data;
        return this.cache;
      }
      logger.warn("Settings file failed validation, returning defaults", {
        error: result.error.message,
      });
      return getDefaultSettings();
    } catch {
      // File doesn't exist or is not valid JSON
      return getDefaultSettings();
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
    const validated = SettingsSchema().parse(merged);

    // Refuse updates that would disable every provider, which would render the app
    // unusable (every sendMessage would throw ProviderDisabledError). The UI enforces
    // this too, but a direct RPC call would otherwise bypass it.
    const anyEnabled = Object.values(validated.provider.enabled).some(Boolean);
    if (!anyEnabled) {
      throw new Error("At least one provider must remain enabled");
    }

    this.writeAtomically(validated);

    // Update cache directly from the validated result — no need for another disk read
    this.cache = validated;

    broadcast("settings.changed", validated);
    this.emitChange(validated);

    return validated;
  }

  private writeAtomically(document: unknown): void {
    if (!this.dirEnsured) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.dirEnsured = true;
      // If the directory didn't exist at startup, startWatching() will have
      // failed and left this.watcher null. Now that the directory exists,
      // arm the watcher so future external edits are observed.
      if (this.watcher === null) {
        this.startWatching();
      }
    }

    // Atomic write: write to a temp file then rename to avoid partial reads.
    const tmpPath = this.filePath + ".tmp";
    this.selfWrite = true;
    try {
      writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf-8");
      renameSync(tmpPath, this.filePath);
      // Safety: clear selfWrite after a window in case fs.watch never fires.
      setTimeout(() => { this.selfWrite = false; }, 500);
    } catch (err) {
      // Ensure selfWrite is always cleared and temp file cleaned up on failure.
      this.selfWrite = false;
      try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  /**
   * Subscribe to in-process settings changes. Called whenever settings are
   * updated via `update()` or reloaded after an external file edit. Returns
   * an unsubscribe function.
   */
  on(event: "change", cb: (next: Settings) => void): () => void {
    void event;
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== cb);
    };
  }

  private emitChange(next: Settings): void {
    for (const cb of this.changeListeners) {
      try {
        cb(next);
      } catch (err) {
        logger.warn("SettingsService change listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
        // When watching the directory, only react to the settings file.
        // `filename` can be null on some platforms (e.g. Linux inotify edge cases);
        // treat null as "unknown file" and let it through rather than silently dropping.
        if (
          watchTarget !== this.filePath &&
          filename !== null &&
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

          // If we were watching the file directly but it no longer exists
          // (e.g. the user deleted or replaced it), fall back to watching
          // the parent directory so we can recover when it reappears.
          if (watchTarget === this.filePath && !existsSync(this.filePath)) {
            this.dispose();
            this.startWatching();
            return;
          }

          // Invalidate cache so the next get() re-reads from disk
          this.cache = null;
          const settings = this.get();
          broadcast("settings.changed", settings);
          this.emitChange(settings);

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
