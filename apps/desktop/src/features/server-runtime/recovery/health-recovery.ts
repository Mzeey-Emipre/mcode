/** Sliding window for counting silent server restarts. */
export const SERVER_HEALTH_RESTART_WINDOW_MS = 60_000;

/** Silent restarts allowed before health recovery escalates to the crash dialog. */
export const SERVER_HEALTH_RESTART_LIMIT = 3;

/** Logger boundary used by {@link ServerHealthRecovery}. */
export interface ServerHealthRecoveryLogger {
  /** Write an informational recovery message. */
  log: (...args: unknown[]) => void;
  /** Write a recovery failure message. */
  error: (...args: unknown[]) => void;
}

/** Dependencies required by {@link ServerHealthRecovery}. */
export interface ServerHealthRecoveryDeps {
  /** Check whether the server can serve requests. */
  isHealthy: () => Promise<boolean>;
  /** Restart the server after an unhealthy check. */
  restart: () => Promise<void>;
  /** Surface the terminal health-recovery state to the user. */
  showError: () => Promise<void> | void;
  /** Clock injection for deterministic sliding-window tests. */
  now?: () => number;
  /** Logger injection for deterministic recovery diagnostics. */
  logger?: ServerHealthRecoveryLogger;
}

const defaultLogger: ServerHealthRecoveryLogger = {
  log: (...args) => console.log(...args),
  error: (...args) => console.error(...args),
};

/** Coalesces health checks and performs bounded silent server recovery. */
export class ServerHealthRecovery {
  private readonly isHealthy: () => Promise<boolean>;
  private readonly restart: () => Promise<void>;
  private readonly showError: () => Promise<void> | void;
  private readonly now: () => number;
  private readonly logger: ServerHealthRecoveryLogger;
  private silentRestartTimestamps: number[] = [];
  private inFlight: Promise<void> | null = null;

  constructor(deps: ServerHealthRecoveryDeps) {
    this.isHealthy = deps.isHealthy;
    this.restart = deps.restart;
    this.showError = deps.showError;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? defaultLogger;
  }

  /** Verify server health and silently restart it when necessary. */
  ensureServerRunning(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      if (await this.isHealthy()) return;

      const now = this.now();
      this.silentRestartTimestamps = this.silentRestartTimestamps.filter(
        (timestamp) => now - timestamp < SERVER_HEALTH_RESTART_WINDOW_MS,
      );
      if (
        this.silentRestartTimestamps.length >= SERVER_HEALTH_RESTART_LIMIT
      ) {
        await this.showError();
        return;
      }
      this.silentRestartTimestamps.push(now);

      this.logger.log("[main] Server unhealthy, restarting silently");
      try {
        await this.restart();
      } catch (error) {
        this.logger.error("[main] Silent server restart failed:", error);
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}
