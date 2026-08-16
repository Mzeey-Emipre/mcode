/**
 * Watches the shared non-Codex filesystem catalog used by Claude, Cursor, and
 * Copilot, then invalidates `SkillService` and broadcasts the affected providers.
 *
 * Mirrors the debounce + fs.watch pattern of `GitWatcherService`.
 */

import { inject, injectable } from "tsyringe";
import { watch, existsSync, type FSWatcher } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "@mcode/shared";
import { broadcast } from "../../../../transport/push";
import { SkillService, copilotUserAgentsDir } from "./skill-service";

const DEBOUNCE_MS = 200;

@injectable()
export class SkillWatcherService {
  private readonly watchers: FSWatcher[] = [];
  // Tracks which dirs already have a live watcher so repeated `watch(dir)`
  // calls (e.g. start() running twice across a stopAll(), or future code
  // paths that add overlapping roots) don't register duplicate FSWatchers
  // and fire the debounce timer twice per change.
  private readonly watchedDirs = new Set<string>();
  // Roots we want watched. Stored on the instance so the parent-dir watch
  // can re-attempt registration when one of them is created post-startup.
  private dynamicRoots: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Tracks whether start() has run, separately from watcher count: a fresh
  // install with no `~/.claude/{skills,commands,plugins}` directories would
  // otherwise leave `watchers.length === 0`, defeating the idempotency guard.
  private started = false;

  /** Fires after SkillService.invalidate() inside the debounced watcher (optional). */
  private debouncedListener?: () => void;

  constructor(
    @inject(SkillService) private readonly skills: SkillService,
  ) {}

  /**
   * Registers a callback invoked once per debounced filesystem burst after the
   * skill catalogue cache resets. Providers (e.g. Cursor ACP sticky prompts)
   * use this to reshuffle deterministic instruction hashing.
   */
  registerDebouncedInvalidateListener(listener: () => void): void {
    this.debouncedListener = listener;
  }

  /**
   * Begin watching roots used by the shared non-Codex filesystem catalog.
   * Idempotent: subsequent calls are no-ops until `stopAll()` resets state.
   *
   * Also watches provider parent directories so roots that do not exist at
   * startup get registered
   * automatically when the directory is created later.
   *
   * @param overrides Optional path overrides for testing. Production callers
   *   should call `start()` with no arguments.
   */
  start(overrides?: { parentDirs?: string[]; roots?: string[] }): void {
    if (this.started) {
      logger.debug("SkillWatcherService: start() ignored, already started", {
        watcherCount: this.watchers.length,
      });
      return;
    }
    this.started = true;
    const home = homedir();
    const claudeDir = join(home, ".claude");
    const cursorDir = join(home, ".cursor");

    const parentDirs =
      overrides?.parentDirs ?? [claudeDir, cursorDir];
    const roots = overrides?.roots ?? [
      // Claude roots
      join(claudeDir, "skills"),
      join(claudeDir, "commands"),
      join(claudeDir, "plugins"),
      join(claudeDir, ".agents", "skills"),
      // Copilot user-level agents
      copilotUserAgentsDir(),
      // Cursor CLI roots (skills/commands/plugins mirror Claude-style layout)
      join(cursorDir, "skills"),
      join(cursorDir, "commands"),
      join(cursorDir, "plugins"),
    ];

    this.dynamicRoots = roots;
    for (const parentDir of parentDirs) this.watchParent(parentDir);
    for (const root of roots) this.watch(root);
  }

  /**
   * Watch the parent dir non-recursively so creation of any of `dynamicRoots`
   * post-startup triggers a (re-)registration. Recursive watching here would
   * fire on every plugin file write — far too noisy. Non-recursive sees only
   * direct children of the parent, which is exactly the granularity we need.
   */
  private watchParent(parentDir: string): void {
    if (!existsSync(parentDir)) {
      logger.debug("SkillWatcherService: parent dir missing, dynamic-root detection disabled", {
        parentDir,
      });
      return;
    }
    if (this.watchedDirs.has(parentDir)) return;
    try {
      const w = watch(parentDir, () => this.onParentChange(parentDir));
      this.attachErrorHandler(w, parentDir);
      this.watchers.push(w);
      this.watchedDirs.add(parentDir);
    } catch (err) {
      const message = (err as Error).message;
      logger.debug("SkillWatcherService: parent watch failed", { parentDir, message });
    }
  }

  /**
   * Re-attempt registration of any dynamic root that's not currently watched
   * (it may have just been created), then trigger the normal debounced
   * invalidate. `watch()` is dedup'd and skips missing dirs, so this is safe
   * to invoke on every parent-dir event.
   */
  private onParentChange(parentDir: string): void {
    for (const root of this.dynamicRoots) {
      if (!this.watchedDirs.has(root)) this.watch(root);
    }
    this.onChange(parentDir);
  }

  /** Begin watching one directory. No-op when the path is missing or already watched. */
  watch(dir: string): void {
    if (!existsSync(dir)) {
      logger.debug("SkillWatcherService: skip missing dir", { dir });
      return;
    }
    if (this.watchedDirs.has(dir)) {
      logger.debug("SkillWatcherService: skip already-watched dir", { dir });
      return;
    }
    try {
      const w = watch(dir, { recursive: true }, () => this.onChange(dir));
      this.attachErrorHandler(w, dir);
      this.watchers.push(w);
      this.watchedDirs.add(dir);
    } catch (err) {
      // Some platforms (BSD, network FS) reject recursive — fall back.
      const outerMessage = (err as Error).message;
      logger.debug("SkillWatcherService: recursive watch failed, falling back", {
        dir,
        message: outerMessage,
      });
      try {
        const w = watch(dir, () => this.onChange(dir));
        this.attachErrorHandler(w, dir);
        this.watchers.push(w);
        this.watchedDirs.add(dir);
      } catch (innerErr) {
        const message = (innerErr as Error).message;
        logger.warn("SkillWatcherService: watch failed", { dir, message });
      }
    }
  }

  /** Tear down every watcher (called from shutdown / tests). */
  stopAll(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers.length = 0;
    this.watchedDirs.clear();
    this.dynamicRoots = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.debouncedListener = undefined;
    this.started = false;
  }

  /**
   * Wire a `error` handler so a single bad watcher cannot crash the process.
   * On error, log at debug, close the watcher, and drop it from the registry.
   */
  private attachErrorHandler(w: FSWatcher, dir: string): void {
    w.on("error", (err) => {
      logger.debug("SkillWatcherService: watcher error, dropping", {
        dir,
        message: err.message,
      });
      try {
        w.close();
      } catch {
        // ignore
      }
      const idx = this.watchers.indexOf(w);
      if (idx !== -1) this.watchers.splice(idx, 1);
      // Drop the dir from the dedup set too — otherwise a subsequent
      // watch() for the same path would silently no-op even though the
      // previous watcher is dead.
      this.watchedDirs.delete(dir);
    });
  }

  private onChange(dir: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      logger.debug("SkillWatcherService: debounced change", { dir });
      // A SkillService throw must not poison subsequent debounce cycles.
      try {
        this.skills.invalidate();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug("SkillWatcherService: invalidate failed", { dir, message });
        return;
      }
      try {
        broadcast("skills.changed", { providerIds: ["claude", "copilot", "cursor"] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug("SkillWatcherService: broadcast failed", { dir, message });
      }
      try {
        this.debouncedListener?.();
      } catch (listenerErr) {
        logger.debug("SkillWatcherService: debounced listener failed", {
          dir,
          message: listenerErr instanceof Error ? listenerErr.message : String(listenerErr),
        });
      }
    }, DEBOUNCE_MS);
  }
}
