/**
 * Lifecycle-aware memory pressure management.
 * Tracks idle state (active / warm-idle / background-idle) and applies
 * progressive memory reclamation: SQLite shrink + minor GC on warm idle,
 * full GC + aggressive cache reduction on background idle.
 */

import { injectable, inject } from "tsyringe";
import type Database from "better-sqlite3";
import { logger } from "@mcode/shared";

/** Idle state levels, from most active to most aggressive reclamation. */
type IdleState = "active" | "warm-idle" | "background-idle";

/** Warm idle delay: 30 seconds after last agent finishes. */
const WARM_IDLE_DELAY_MS = 30_000;

/** Background idle delay: 60 seconds after window loses focus. */
const BACKGROUND_IDLE_DELAY_MS = 60_000;

/** Normal SQLite page cache size (2MB, set by database.ts). */
const NORMAL_CACHE_KB = 2000;

/** Reduced SQLite page cache size during background idle (500KB). */
const BACKGROUND_CACHE_KB = 500;

/** Manages memory pressure based on application idle state. */
@injectable()
export class MemoryPressureService {
  private state: IdleState = "active";
  private warmIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private isWindowBackground = false;

  constructor(@inject("Database") private readonly db: Database.Database) {}

  /** Current idle state. Exposed for diagnostics. */
  get currentState(): IdleState {
    return this.state;
  }

  /**
   * Signal that an agent has started or the user is interacting.
   * Cancels all idle timers and restores normal cache levels.
   */
  markActive(): void {
    this.clearTimers();
    if (this.state === "background-idle") {
      this.restoreFromBackground();
    }
    this.state = "active";
  }

  /**
   * Signal that no agents are running.
   * Starts the appropriate idle timer based on window focus state.
   */
  markIdle(): void {
    this.clearTimers();
    if (this.isWindowBackground) {
      this.backgroundIdleTimer = setTimeout(
        () => this.enterBackgroundIdle(),
        BACKGROUND_IDLE_DELAY_MS,
      );
    } else {
      this.warmIdleTimer = setTimeout(
        () => this.enterWarmIdle(),
        WARM_IDLE_DELAY_MS,
      );
    }
  }

  /**
   * Signal that the application window has lost focus.
   * If no agents are running, starts the background idle timer.
   */
  markBackground(): void {
    this.isWindowBackground = true;
    if (this.state === "active") return;
    this.clearTimers();
    this.backgroundIdleTimer = setTimeout(
      () => this.enterBackgroundIdle(),
      BACKGROUND_IDLE_DELAY_MS,
    );
  }

  /**
   * Signal that the application window has regained focus.
   * Restores cache levels if in background idle.
   */
  markForeground(): void {
    this.isWindowBackground = false;
    if (this.state === "background-idle") {
      this.restoreFromBackground();
      this.state = "warm-idle";
    }
    if (this.backgroundIdleTimer) {
      clearTimeout(this.backgroundIdleTimer);
      this.backgroundIdleTimer = null;
    }
  }

  /** Clean up timers on shutdown. */
  dispose(): void {
    this.clearTimers();
  }

  private enterWarmIdle(): void {
    this.state = "warm-idle";
    logger.info("Entering warm idle: shrinking SQLite + minor GC");
    try {
      this.db.pragma("shrink_memory");
    } catch (err) {
      logger.warn("shrink_memory failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (typeof global.gc === "function") {
      global.gc();
    }
  }

  private enterBackgroundIdle(): void {
    this.state = "background-idle";
    logger.info("Entering background idle: full GC + cache reduction");
    try {
      this.db.pragma(`cache_size = -${BACKGROUND_CACHE_KB}`);
    } catch (err) {
      logger.warn("cache_size reduction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (typeof global.gc === "function") {
      global.gc(true); // Full mark-sweep-compact
    }
  }

  private restoreFromBackground(): void {
    logger.info("Restoring from background idle: normal cache size");
    try {
      this.db.pragma(`cache_size = -${NORMAL_CACHE_KB}`);
    } catch (err) {
      logger.warn("cache_size restore failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private clearTimers(): void {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
    if (this.backgroundIdleTimer) {
      clearTimeout(this.backgroundIdleTimer);
      this.backgroundIdleTimer = null;
    }
  }
}
