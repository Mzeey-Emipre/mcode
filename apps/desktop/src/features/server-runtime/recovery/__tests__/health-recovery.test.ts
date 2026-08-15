import { describe, expect, it, vi } from "vitest";
import {
  SERVER_HEALTH_RESTART_LIMIT,
  SERVER_HEALTH_RESTART_WINDOW_MS,
  ServerHealthRecovery,
} from "../health-recovery.js";

function createRecovery(overrides: {
  isHealthy?: () => Promise<boolean>;
  restart?: () => Promise<void>;
  showError?: () => Promise<void> | void;
  now?: () => number;
  logger?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
} = {}) {
  return new ServerHealthRecovery({
    isHealthy: overrides.isHealthy ?? vi.fn().mockResolvedValue(false),
    restart: overrides.restart ?? vi.fn().mockResolvedValue(undefined),
    showError: overrides.showError ?? vi.fn(),
    now: overrides.now,
    logger: overrides.logger,
  });
}

describe("ServerHealthRecovery", () => {
  it("does not restart a healthy server", async () => {
    const isHealthy = vi.fn().mockResolvedValue(true);
    const restart = vi.fn().mockResolvedValue(undefined);

    await createRecovery({ isHealthy, restart }).ensureServerRunning();

    expect(isHealthy).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it("coalesces concurrent health recovery requests", async () => {
    let resolveHealth!: (healthy: boolean) => void;
    const isHealthy = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveHealth = resolve)),
    );
    const restart = vi.fn().mockResolvedValue(undefined);
    const recovery = createRecovery({ isHealthy, restart });

    const first = recovery.ensureServerRunning();
    const second = recovery.ensureServerRunning();
    resolveHealth(false);
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(isHealthy).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
  });

  it("restarts an unhealthy server and logs the attempt", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const logger = { log: vi.fn(), error: vi.fn() };

    await createRecovery({ restart, logger }).ensureServerRunning();

    expect(logger.log).toHaveBeenCalledWith(
      "[main] Server unhealthy, restarting silently",
    );
    expect(restart).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("escalates after the silent restart limit", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();
    let now = 1_000;
    const recovery = createRecovery({
      restart,
      showError,
      now: () => now,
    });

    for (let attempt = 0; attempt < SERVER_HEALTH_RESTART_LIMIT; attempt += 1) {
      await recovery.ensureServerRunning();
      now += 1_000;
    }
    await recovery.ensureServerRunning();

    expect(restart).toHaveBeenCalledTimes(SERVER_HEALTH_RESTART_LIMIT);
    expect(showError).toHaveBeenCalledOnce();
  });

  it("logs and swallows restart failures", async () => {
    const failure = new Error("restart failed");
    const restart = vi.fn().mockRejectedValue(failure);
    const logger = { log: vi.fn(), error: vi.fn() };

    await expect(createRecovery({ restart, logger }).ensureServerRunning()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      "[main] Silent server restart failed:",
      failure,
    );
  });

  it("forgets silent restarts outside the sliding window", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();
    let now = 1_000;
    const recovery = createRecovery({ restart, showError, now: () => now });

    for (let attempt = 0; attempt < SERVER_HEALTH_RESTART_LIMIT; attempt += 1) {
      await recovery.ensureServerRunning();
      now += 1_000;
    }
    now += SERVER_HEALTH_RESTART_WINDOW_MS;
    await recovery.ensureServerRunning();

    expect(restart).toHaveBeenCalledTimes(SERVER_HEALTH_RESTART_LIMIT + 1);
    expect(showError).not.toHaveBeenCalled();
  });
});
