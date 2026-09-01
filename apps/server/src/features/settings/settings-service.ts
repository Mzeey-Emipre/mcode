/**
 * User settings service.
 * Reads and writes settings.json from the Mcode data directory,
 * watches for external changes, and broadcasts updates to connected clients.
 */

import { injectable } from "tsyringe";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  SettingsSchema,
  getDefaultSettings,
  type Settings,
  type PartialSettings,
  type TerminalPreferencesUpdate,
  type TerminalSettings,
  type TerminalCustomProfile,
  type TerminalProfileRecovery,
  TerminalProfileReferenceSchema,
  TerminalCustomProfileSchema,
  getDefaultTerminalSettingsDocument,
} from "@mcode/contracts";
import { getMcodeDir, logger } from "@mcode/shared";
import { broadcast } from "../../application/transport/push.js";
import { migrateTerminalSettingsDocument } from "../terminal/preferences/terminal-settings-migration.js";

const SETTINGS_MAX_BYTES = 512 * 1_024;
const TERMINAL_SETTINGS_BACKUP_NAME = "settings.json.pre-terminal-0.0.1.bak";

/** Raised when a malformed or future settings file must remain untouched. */
export class SettingsWriteBlockedError extends Error {
  readonly code = "SETTINGS_WRITE_BLOCKED" as const;

  constructor() {
    super("Settings writes are blocked until the settings file is repaired or reset");
    this.name = "SettingsWriteBlockedError";
  }
}

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

function removeLegacyUnsafeWorktreePolicy(value: unknown): {
  readonly changed: boolean;
  readonly document: unknown;
} {
  if (!isRecord(value) || !isRecord(value.thread) || !isRecord(value.thread.completion)) {
    return { changed: false, document: value };
  }
  if (!Object.prototype.hasOwnProperty.call(value.thread.completion, "unsafeWorktreePolicy")) {
    return { changed: false, document: value };
  }

  const completion = { ...value.thread.completion };
  delete completion.unsafeWorktreePolicy;
  const thread = { ...value.thread };
  if (Object.keys(completion).length === 0) {
    delete thread.completion;
  } else {
    thread.completion = completion;
  }
  const document = { ...value };
  if (Object.keys(thread).length === 0) {
    delete document.thread;
  } else {
    document.thread = thread;
  }
  return { changed: true, document };
}

function getSettingsDefaults(): Settings {
  const defaults = getDefaultSettings();
  if (process.env.MCODE_AGENT_RUNTIME !== "1") {
    return defaults;
  }

  return {
    ...defaults,
    model: {
      ...defaults.model,
      defaults: {
        ...defaults.model.defaults,
        provider: "codex",
        id: "gpt-5.6-luna",
        fallbackId: "",
      },
    },
  };
}

/**
 * Manages persistent user settings stored as JSON on disk.
 * Provides get/update operations with Zod validation and broadcasts
 * changes to all connected WebSocket clients.
 */
@injectable()
export class SettingsService {
  private readonly filePath: string;
  private watcher: NodeFS.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the last write originated from this process (used to skip self-triggered watch events). */
  private selfWrite = false;

  /** In-memory cache of the last validated settings. Populated on first read, invalidated on external change. */
  private cache: Settings | null = null;

  /** Whether the parent directory has already been created, to avoid redundant mkdirSync calls. */
  private dirEnsured = false;

  /** In-process change listeners registered via `on("change", cb)`. */
  private changeListeners: Array<(next: Settings) => void> = [];
  private terminalMigrationStatus:
    | { readonly status: "current" | "migrated" }
    | {
        readonly status: "blocked";
        readonly reason:
          | "malformed"
          | "future-version"
          | "missing-profile-reference"
          | "migration-write-failed";
      }
    = { status: "current" };
  private blockedTerminalProfiles: readonly TerminalCustomProfile[] = [];
  private blockedTerminalProfileReference: TerminalProfileRecovery["unavailableProfileId"] = null;

  constructor() {
    this.filePath = NodePath.join(getMcodeDir(), "settings.json");
    this.startWatching();
  }

  /**
   * Read the current settings from disk.
   * Returns the cached value if available. On cache miss, reads from disk,
   * validates, and populates the cache. Never throws; returns
   * Runtime-aware defaults if the file is missing or contains invalid JSON.
   */
  get(): Settings {
    if (this.cache !== null) return this.cache;
    try {
      const settings = this.readSettingsFile();
      if (settings) this.cache = settings;
      return settings ?? getSettingsDefaults();
    } catch {
      return this.handleSettingsReadFailure();
    }
  }

  /**
   * Deep-merge a partial settings object into the current settings,
   * write the result to disk, and broadcast a `settings.changed` push event.
   * Returns the merged settings with defaults applied.
   */
  update(partial: PartialSettings): Settings {
    this.assertWritesAllowed();
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

  /** Returns the current Terminal settings migration state. */
  getTerminalMigrationStatus():
    | { readonly status: "current" | "migrated" }
    | {
        readonly status: "blocked";
        readonly reason:
          | "malformed"
          | "future-version"
          | "missing-profile-reference"
          | "migration-write-failed";
      } {
    this.get();
    return this.terminalMigrationStatus;
  }

  /** Returns bounded recovery data for a blocked Terminal settings document. */
  getTerminalRecoveryState(): TerminalProfileRecovery | null {
    const status = this.getTerminalMigrationStatus();
    if (status.status !== "blocked") return null;
    return {
      status: "blocked",
      reason: status.reason,
      blockedProfiles: [...this.blockedTerminalProfiles],
      unavailableProfileId: this.blockedTerminalProfileReference,
    };
  }

  /** Replaces the validated Terminal subtree and persists the complete settings document. */
  replaceTerminalSettings(terminal: TerminalSettings): TerminalSettings {
    this.assertWritesAllowed();
    const validated = SettingsSchema().parse({ ...this.get(), terminal });
    this.persistValidatedSettings(validated);
    return validated.terminal;
  }

  /** Applies presentation, behavior, or accessibility changes through the dedicated Terminal seam. */
  updateTerminalPreferences(update: TerminalPreferencesUpdate): TerminalSettings {
    this.assertWritesAllowed();
    const current = this.get().terminal;
    return this.replaceTerminalSettings({
      ...current,
      presentation: { ...current.presentation, ...update.presentation },
      behavior: { ...current.behavior, ...update.behavior },
      accessibility: { ...current.accessibility, ...update.accessibility },
    });
  }

  /** Restores Terminal preferences and default selection while preserving custom profiles. */
  resetTerminalPreferences(): TerminalSettings {
    this.get();
    if (this.terminalMigrationStatus.status === "blocked") {
      const defaults = getDefaultSettings();
      const repaired = {
        ...defaults,
        terminal: {
          ...defaults.terminal,
          profiles: [...this.blockedTerminalProfiles],
        },
      };
      this.terminalMigrationStatus = { status: "current" };
      this.blockedTerminalProfiles = [];
      this.blockedTerminalProfileReference = null;
      this.persistValidatedSettings(repaired);
      return repaired.terminal;
    }

    const current = this.get().terminal;
    const defaults = getDefaultTerminalSettingsDocument().terminal;
    return this.replaceTerminalSettings({
      ...defaults,
      profiles: current.profiles,
    });
  }

  private assertWritesAllowed(): void {
    this.get();
    if (this.terminalMigrationStatus.status === "blocked") {
      throw new SettingsWriteBlockedError();
    }
  }

  private readSettingsFile(): Settings | null {
    const raw = NodeFS.readFileSync(this.filePath, "utf-8");
    if (Buffer.byteLength(raw, "utf8") > SETTINGS_MAX_BYTES) {
      this.blockTerminalMigration("malformed");
      return null;
    }
    return this.readSettingsDocument(JSON.parse(raw) as unknown);
  }

  private readSettingsDocument(parsed: unknown): Settings | null {
    const previewMigration = removeLegacyPreviewRenderingSetting(parsed);
    const worktreeMigration = removeLegacyUnsafeWorktreePolicy(previewMigration.document);
    const terminalMigration = migrateTerminalSettingsDocument(worktreeMigration.document);
    if (terminalMigration.status === "blocked") {
      this.blockTerminalMigration(terminalMigration.reason, terminalMigration.original);
      logger.warn("Settings file failed Terminal migration, returning temporary defaults", {
        reason: terminalMigration.reason,
      });
      return null;
    }

    const result = SettingsSchema().safeParse(terminalMigration.document);
    if (!result.success) {
      logger.warn("Settings file failed validation, returning defaults", {
        error: result.error.message,
      });
      this.clearBlockedTerminalRecovery();
      return null;
    }

    const migratedTerminalSettings = terminalMigration.status === "migrated";
    this.clearBlockedTerminalRecovery();
    this.terminalMigrationStatus = { status: terminalMigration.status };
    this.persistSettingsMigration(
      result.data,
      previewMigration.changed || worktreeMigration.changed || migratedTerminalSettings,
      migratedTerminalSettings,
    );
    return result.data;
  }

  private persistSettingsMigration(
    settings: Settings,
    shouldPersist: boolean,
    requiresBackup: boolean,
  ): void {
    if (!shouldPersist) return;
    try {
      if (requiresBackup) this.preserveTerminalMigrationBackup();
      this.writeAtomically(settings);
    } catch (error) {
      if (requiresBackup) {
        this.terminalMigrationStatus = {
          status: "blocked",
          reason: "migration-write-failed",
        };
      }
      logger.warn("Failed to persist migrated settings", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private blockTerminalMigration(
    reason: "malformed" | "future-version" | "missing-profile-reference",
    original?: unknown,
  ): void {
    this.terminalMigrationStatus = { status: "blocked", reason };
    this.blockedTerminalProfiles = reason === "missing-profile-reference"
      ? parseBlockedTerminalProfiles(original)
      : [];
    this.blockedTerminalProfileReference = reason === "missing-profile-reference"
      ? parseBlockedTerminalProfileReference(original)
      : null;
  }

  private clearBlockedTerminalRecovery(): void {
    this.blockedTerminalProfiles = [];
    this.blockedTerminalProfileReference = null;
  }

  private handleSettingsReadFailure(): Settings {
    this.terminalMigrationStatus = NodeFS.existsSync(this.filePath)
      ? { status: "blocked", reason: "malformed" }
      : { status: "current" };
    this.clearBlockedTerminalRecovery();
    return getSettingsDefaults();
  }

  private persistValidatedSettings(validated: Settings): void {
    this.writeAtomically(validated);
    this.cache = validated;
    broadcast("settings.changed", validated);
    this.emitChange(validated);
  }

  private preserveTerminalMigrationBackup(): void {
    const backupPath = NodePath.join(NodePath.dirname(this.filePath), TERMINAL_SETTINGS_BACKUP_NAME);
    if (!NodeFS.existsSync(backupPath)) {
      NodeFS.copyFileSync(this.filePath, backupPath);
    }
  }

  private writeAtomically(document: unknown): void {
    if (!this.dirEnsured) {
      NodeFS.mkdirSync(NodePath.dirname(this.filePath), { recursive: true });
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
      NodeFS.writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf-8");
      NodeFS.renameSync(tmpPath, this.filePath);
      // Safety: clear selfWrite after a window in case fs.watch never fires.
      setTimeout(() => { this.selfWrite = false; }, 500);
    } catch (err) {
      // Ensure selfWrite is always cleared and temp file cleaned up on failure.
      this.selfWrite = false;
      try { NodeFS.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
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
    const watchTarget = NodeFS.existsSync(this.filePath)
      ? this.filePath
      : NodePath.dirname(this.filePath);

    try {
      this.watcher = NodeFS.watch(watchTarget, (_eventType, filename) => {
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
          if (watchTarget === this.filePath && !NodeFS.existsSync(this.filePath)) {
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
          if (watchTarget !== this.filePath && NodeFS.existsSync(this.filePath)) {
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

function parseBlockedTerminalProfiles(value: unknown): readonly TerminalCustomProfile[] {
  if (!isRecord(value) || !isRecord(value.terminal)) return [];
  const result = TerminalCustomProfileSchema().array().max(32).safeParse(value.terminal.profiles);
  if (!result.success || new Set(result.data.map((profile) => profile.id)).size !== result.data.length) {
    return [];
  }
  return result.data;
}

function parseBlockedTerminalProfileReference(
  value: unknown,
): TerminalProfileRecovery["unavailableProfileId"] {
  if (!isRecord(value) || !isRecord(value.terminal)) return null;
  const result = TerminalProfileReferenceSchema().safeParse(value.terminal.defaultProfileId);
  return result.success ? result.data : null;
}
