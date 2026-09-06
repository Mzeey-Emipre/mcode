import { consoleRecoveryLogger, type RecoveryLogger } from "./logger.js";

const SERVER_HEALTH_RESTART_WINDOW_MS = 60_000;

const SERVER_HEALTH_RESTART_LIMIT = 3;

interface ServerHealthRecoveryDeps {
  isHealthy: () => Promise<boolean>;
  restart: () => Promise<void>;
  showError: () => Promise<void> | void;
  now?: () => number;
  logger?: RecoveryLogger;
}

/** Coalesces health checks and performs bounded silent server recovery. */
export class ServerHealthRecovery {
  private readonly isHealthy: () => Promise<boolean>;
  private readonly restart: () => Promise<void>;
  private readonly showError: () => Promise<void> | void;
  private readonly now: () => number;
  private readonly logger: RecoveryLogger;
  private silentRestartTimestamps: number[] = [];
  private inFlight: Promise<void> | null = null;

  constructor(deps: ServerHealthRecoveryDeps) {
    this.isHealthy = deps.isHealthy;
    this.restart = deps.restart;
    this.showError = deps.showError;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? consoleRecoveryLogger;
  }

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
