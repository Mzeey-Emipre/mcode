/**
 * Lifecycle-aware memory pressure management.
 * Tracks idle state and active-turn V8 heap pressure, then asks callers to shed
 * memory before the process reaches an unrecoverable heap limit.
 */

import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { logger } from "@mcode/shared";
import { SettingsService } from "../../features/settings/settings-service.js";
import {
  applySQLiteCacheBudget,
  optimizeSQLiteConnection,
} from "../persistence/sqlite/sqlite-connection-policy.js";
import {
  sampleRuntimeMemory,
  type RuntimeMemoryMeasurement,
} from "./runtime-memory-sampler.js";

/**
 * Idle state levels, from most active to most aggressive reclamation.
 * - `active`: at least one agent session is running or the user just interacted.
 * - `warm-idle`: no active sessions for 30s; SQLite shrunk, minor GC fired.
 * - `background-idle`: window is backgrounded and idle for 60s; full GC + reduced cache.
 */
type IdleState = "active" | "warm-idle" | "background-idle";

/** Active server-memory pressure level derived from measured use and its budget. */
export type MemoryPressureLevel = "normal" | "warning" | "critical";

/** Server-memory pressure snapshot broadcast to provider and pool shedding hooks. */
export interface MemoryPressureSnapshot {
  /** Current server-memory pressure level. */
  level: MemoryPressureLevel;
  /** Whether the sample is V8 heap use or Bun process RSS. */
  source: RuntimeMemoryMeasurement["source"];
  /** Measured memory bytes at the sample. */
  usedBytes: number;
  /** V8 heap limit or Bun's configured soft process budget in bytes. */
  budgetBytes: number;
  /** Measured bytes divided by the admission budget. */
  ratio: number;
}

/** Warm idle delay: 30 seconds after last agent finishes. */
const WARM_IDLE_DELAY_MS = 30_000;

/** Background idle delay: 60 seconds after window loses focus. */
const BACKGROUND_IDLE_DELAY_MS = 60_000;

/** Poll interval while at least one turn is active. */
const ACTIVE_MEMORY_POLL_MS = 1_000;

/** Warning threshold: output buffering sheds memory and idle pools are evicted. */
const WARNING_HEAP_RATIO = 0.8;

/** Critical threshold: new turns are rejected until pressure clears. */
const CRITICAL_HEAP_RATIO = 0.9;

/** Minimum time between full GC invocations (5 minutes). */
const MIN_FULL_GC_INTERVAL_MS = 5 * 60_000;

/** Manages memory pressure based on application idle state and runtime memory use. */
@injectable()
export class MemoryPressureService {
  private state: IdleState = "active";
  private warmIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeMemoryTimer: ReturnType<typeof setInterval> | null = null;
  private isWindowBackground = false;
  private lastFullGcAt = 0;
  private readonly activeTurns = new Set<string>();
  private readonly turnHighWater = new Map<string, MemoryPressureSnapshot>();
  private readonly pressureListeners = new Set<(snapshot: MemoryPressureSnapshot) => void>();
  private pressure: MemoryPressureSnapshot = {
    level: "normal",
    source: "v8-heap",
    usedBytes: 0,
    budgetBytes: 0,
    ratio: 0,
  };

  /** Creates the service with a reference to the SQLite database. */
  constructor(
    @inject("Database") private readonly db: Database,
    @inject(SettingsService) private readonly settings: Pick<SettingsService, "get">,
  ) {}

  /** Current idle state. Exposed for diagnostics. */
  get currentState(): IdleState {
    return this.state;
  }

  /** Current active-turn memory pressure. Exposed for diagnostics and gates. */
  get currentPressure(): MemoryPressureSnapshot {
    return this.pressure;
  }

  /** Register a listener invoked when active-turn memory pressure changes level. */
  onPressureChange(listener: (snapshot: MemoryPressureSnapshot) => void): () => void {
    this.pressureListeners.add(listener);
    return () => {
      this.pressureListeners.delete(listener);
    };
  }

  /**
   * Reject starting a new turn while another active turn has pushed memory
   * into the critical band.
   */
  assertCanStartTurn(measurement?: RuntimeMemoryMeasurement): void {
    const snapshot = this.snapshot(measurement ?? this.measureRuntimeMemory());
    if (this.activeTurns.size > 0 || this.pressure.level === "critical" || snapshot.level !== "normal") {
      this.setPressure(snapshot);
    }
    if (snapshot.level !== "critical") return;
    throw new Error("Memory pressure is critical. Wait for the active turn to finish before starting another turn.");
  }

  /**
   * Signal that an agent has started or the user is interacting.
   * Cancels all idle timers and restores normal cache levels if coming
   * from background-idle. Warm-idle does not change cache_size, so no
   * restore is needed when transitioning from warm-idle to active.
   */
  markActive(threadId?: string): void {
    this.clearIdleTimers();
    if (this.state === "background-idle") {
      this.restoreFromBackground();
    }
    this.state = "active";
    if (threadId) {
      this.activeTurns.add(threadId);
      this.startActiveMemoryPolling();
      this.sampleActiveMemory();
    }
  }

  /**
   * Signal that a thread or all agents are idle.
   * Starts the appropriate idle timer only when no active turns remain.
   */
  markIdle(threadId?: string): void {
    if (threadId) {
      this.finishActiveTurn(threadId);
      if (this.activeTurns.size > 0) {
        if (this.pressure.level !== "normal") {
          this.notifyPressureListeners(this.pressure);
        }
        return;
      }
    }
    if (!threadId && this.activeTurns.size > 0) return;
    this.stopActiveMemoryPolling();
    this.setPressure({ level: "normal", source: this.pressure.source, usedBytes: 0, budgetBytes: 0, ratio: 0 });
    this.clearIdleTimers();
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
    if (this.activeTurns.size > 0 || this.state === "active") return;
    this.clearIdleTimers();
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
    this.clearIdleTimers();
    this.stopActiveMemoryPolling();
  }

  /** Test hook for deterministic runtime-memory sampling. */
  sampleActiveMemoryForTest(measurement: RuntimeMemoryMeasurement): void {
    this.sampleActiveMemory(measurement);
  }

  private startActiveMemoryPolling(): void {
    if (this.activeMemoryTimer) return;
    this.activeMemoryTimer = setInterval(() => this.sampleActiveMemory(), ACTIVE_MEMORY_POLL_MS);
    this.activeMemoryTimer.unref?.();
  }

  private stopActiveMemoryPolling(): void {
    if (!this.activeMemoryTimer) return;
    clearInterval(this.activeMemoryTimer);
    this.activeMemoryTimer = null;
  }

  private sampleActiveMemory(measurement = this.measureRuntimeMemory()): void {
    if (this.activeTurns.size === 0) return;
    const snapshot = this.snapshot(measurement);

    for (const threadId of this.activeTurns) {
      const prev = this.turnHighWater.get(threadId);
      if (!prev || snapshot.usedBytes > prev.usedBytes) {
        this.turnHighWater.set(threadId, snapshot);
      }
    }
    this.setPressure(snapshot);
  }

  private measureRuntimeMemory(): RuntimeMemoryMeasurement {
    return sampleRuntimeMemory(this.settings.get().server.memory.heapMb);
  }

  private snapshot(measurement: RuntimeMemoryMeasurement): MemoryPressureSnapshot {
    const ratio = measurement.usedBytes / measurement.budgetBytes;
    const level: MemoryPressureLevel =
      ratio >= CRITICAL_HEAP_RATIO
        ? "critical"
        : ratio >= WARNING_HEAP_RATIO
          ? "warning"
          : "normal";
    return { level, ...measurement, ratio };
  }

  private setPressure(snapshot: MemoryPressureSnapshot): void {
    const previousLevel = this.pressure.level;
    this.pressure = snapshot;
    if (previousLevel === snapshot.level) return;
    logger.info("Memory pressure level changed", {
      level: snapshot.level,
      ratio: snapshot.ratio,
      source: snapshot.source,
      usedBytes: snapshot.usedBytes,
      budgetBytes: snapshot.budgetBytes,
    });
    this.notifyPressureListeners(snapshot);
  }

  private notifyPressureListeners(snapshot: MemoryPressureSnapshot): void {
    for (const listener of this.pressureListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn("Memory pressure listener failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private finishActiveTurn(threadId: string): void {
    this.activeTurns.delete(threadId);
    const highWater = this.turnHighWater.get(threadId);
    if (highWater) {
      logger.info("Agent turn memory high-watermark", {
        threadId,
        source: highWater.source,
        usedBytes: highWater.usedBytes,
        budgetBytes: highWater.budgetBytes,
        ratio: highWater.ratio,
      });
      this.turnHighWater.delete(threadId);
    }
  }

  /**
   * Transition to warm-idle: fires SQLite shrink_memory pragma and a minor
   * GC pass. Cache size is left unchanged; only background-idle reduces it.
   */
  private enterWarmIdle(): void {
    this.state = "warm-idle";
    logger.info("Entering warm idle: shrinking SQLite + minor GC");
    try {
      optimizeSQLiteConnection(this.db, "maintenance");
    } catch (err) {
      logger.warn("SQLite optimization failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.db.run("PRAGMA shrink_memory");
    } catch (err) {
      logger.warn("shrink_memory failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (typeof global.gc === "function") {
      global.gc();
    }
  }

  /**
   * Transition to background-idle: reduces SQLite cache_size to 500KB then
   * fires a full mark-sweep-compact GC, subject to a 5-minute cooldown.
   * State is set last so it always reflects the actual DB state.
   */
  private enterBackgroundIdle(): void {
    logger.info("Entering background idle: full GC + cache reduction");
    try {
      applySQLiteCacheBudget(this.db, "background");
    } catch (err) {
      logger.warn("cache_size reduction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const now = Date.now();
    if (typeof global.gc === "function" && now - this.lastFullGcAt > MIN_FULL_GC_INTERVAL_MS) {
      this.lastFullGcAt = now;
      global.gc(true);
    }
    this.state = "background-idle";
  }

  /**
   * Restore SQLite cache_size to the normal 2MB level after leaving
   * background-idle. Called by both markActive() and markForeground().
   */
  private restoreFromBackground(): void {
    logger.info("Restoring from background idle: normal cache size");
    try {
      applySQLiteCacheBudget(this.db, "active");
    } catch (err) {
      logger.warn("cache_size restore failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Cancel any pending warm-idle and background-idle timers. */
  private clearIdleTimers(): void {
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
