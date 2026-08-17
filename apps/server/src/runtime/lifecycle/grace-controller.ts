/**
 * Grace-period controller for server lifecycle management.
 *
 * Owns the shutdown-after-idle timer and guards against two failure modes:
 * 1. Shutting down while work is still in progress (busy suppression).
 * 2. Shutting down because the timer fired after the machine woke from sleep
 *    (clock-jump detection via wall-clock elapsed vs. graceMs * 2).
 */

/** Logger subset used by the controller — avoids a hard dependency on a concrete logger. */
export interface GraceLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Dependencies injected by the caller so the controller stays unit-testable. */
export interface GraceDeps {
  /** Grace period length in milliseconds. */
  graceMs: number;
  /** Whether losing every client should start the idle-shutdown countdown. */
  shutdownOnIdle?: boolean;
  /** Returns the current number of active WebSocket sessions. */
  sessionCount(): number;
  /**
   * Returns true when the server has in-flight work that must not be
   * interrupted (active agent turns or running terminal sessions).
   */
  isBusy(): boolean;
  /** Initiates a graceful server shutdown. */
  shutdown(): void;
  /** Logger for lifecycle events. */
  logger: GraceLogger;
  /**
   * Wall-clock timestamp in milliseconds — defaults to Date.now().
   * Injected in tests so fake timers control both setTimeout and elapsed time.
   */
  now?(): number;
}

/** Public interface returned by `createGraceController`. */
export interface GraceController {
  /**
   * Called whenever the WebSocket session count changes.
   * Arms the grace timer at zero, cancels it above zero.
   */
  handleSessionChange(count: number): void;
  /**
   * Cancels any pending timer. Call during shutdown so the timer does not
   * fire after shutdown has already been initiated externally.
   */
  dispose(): void;
}

/**
 * Creates a grace-period controller.
 *
 * The controller arms a countdown timer when all sessions disconnect. When
 * the timer fires it checks three conditions before allowing shutdown:
 *
 * - Sessions have reconnected → clear and ignore.
 * - Server is busy (agents or terminals) → re-arm and wait.
 * - Wall-clock elapsed > graceMs * 2 → machine probably slept through the
 *   countdown; re-arm so the full grace period runs from a clean wake.
 *
 * Only when none of those conditions hold does it invoke shutdown().
 */
export function createGraceController(deps: GraceDeps): GraceController {
  const { graceMs, sessionCount, isBusy, shutdown, logger } = deps;
  const shutdownOnIdle = deps.shutdownOnIdle ?? true;
  const now = deps.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock time at which the current timer was armed. */
  let armedAt: number | null = null;

  function arm(): void {
    if (timer !== null) return; // already armed
    armedAt = now();
    timer = setTimeout(onFire, graceMs);
    logger.info("Grace period armed", { graceMs });
  }

  function cancel(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    armedAt = null;
    logger.info("Grace period cancelled (session reconnected)");
  }

  function reArm(reason: string): void {
    // Clear without logging the cancel message — we log the reason instead.
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    armedAt = now();
    timer = setTimeout(onFire, graceMs);
    logger.info("Grace period re-armed", { reason, graceMs });
  }

  function onFire(): void {
    timer = null;

    // A session reconnected between the arm and the fire.
    if (sessionCount() > 0) {
      armedAt = null;
      logger.info("Grace period fired but sessions are active — ignoring");
      return;
    }

    // Detect a clock jump: if wall-clock elapsed is more than twice graceMs
    // the process almost certainly slept through the countdown. Re-arm so we
    // give the full grace period starting from the wake moment.
    const elapsed = now() - (armedAt ?? now());
    if (elapsed > graceMs * 2) {
      reArm("clock jump detected — machine may have slept");
      return;
    }

    // An agent or terminal is still running. Re-arm and wait.
    if (isBusy()) {
      reArm("server is busy (active agents or terminals)");
      return;
    }

    logger.info("Grace period expired — initiating shutdown");
    shutdown();
  }

  return {
    handleSessionChange(count: number): void {
      if (!shutdownOnIdle) return;
      if (count === 0 && timer === null) {
        arm();
      } else if (count > 0 && timer !== null) {
        cancel();
      }
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        armedAt = null;
      }
    },
  };
}
