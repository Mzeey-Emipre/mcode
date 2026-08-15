import { describe, expect, it, vi } from "vitest";
import {
  SERVER_CRASH_BACKOFF_MS,
  SERVER_CRASH_WINDOW_MS,
  ServerCrashRecovery,
} from "../crash-recovery.js";

describe("ServerCrashRecovery", () => {
  it("restarts after the first abnormal exit with the first backoff delay", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const notifyRecovered = vi.fn();
    const showError = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const recovery = new ServerCrashRecovery({
      restart,
      notifyRecovered,
      showError,
      now: () => 1_000,
      sleep,
    });

    await recovery.handleUnexpectedExit(1);

    expect(sleep).toHaveBeenCalledWith(SERVER_CRASH_BACKOFF_MS[0]);
    expect(restart).toHaveBeenCalledOnce();
    expect(notifyRecovered).toHaveBeenCalledWith(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it("uses bounded backoff and stops after the retry budget is exhausted", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const notifyRecovered = vi.fn();
    const showError = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 10_000;

    const recovery = new ServerCrashRecovery({
      restart,
      notifyRecovered,
      showError,
      now: () => now,
      sleep,
    });

    for (const delay of SERVER_CRASH_BACKOFF_MS) {
      await recovery.handleUnexpectedExit(1);
      expect(sleep).toHaveBeenLastCalledWith(delay);
      now += 1_000;
    }

    await recovery.handleUnexpectedExit(1);

    expect(restart).toHaveBeenCalledTimes(SERVER_CRASH_BACKOFF_MS.length);
    expect(showError).toHaveBeenCalledWith(1);
  });

  it("forgets old crashes outside the crash-loop window", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const notifyRecovered = vi.fn();
    const showError = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 10_000;

    const recovery = new ServerCrashRecovery({
      restart,
      notifyRecovered,
      showError,
      now: () => now,
      sleep,
    });

    await recovery.handleUnexpectedExit(1);
    now += SERVER_CRASH_WINDOW_MS + 1;
    await recovery.handleUnexpectedExit(1);

    expect(sleep).toHaveBeenNthCalledWith(1, SERVER_CRASH_BACKOFF_MS[0]);
    expect(sleep).toHaveBeenNthCalledWith(2, SERVER_CRASH_BACKOFF_MS[0]);
    expect(showError).not.toHaveBeenCalled();
  });

  it("shows the terminal error state when restart fails", async () => {
    const restart = vi.fn().mockRejectedValue(new Error("restart failed"));
    const notifyRecovered = vi.fn();
    const showError = vi.fn();

    const recovery = new ServerCrashRecovery({
      restart,
      notifyRecovered,
      showError,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await recovery.handleUnexpectedExit(1);

    expect(showError).toHaveBeenCalledWith(1);
    expect(notifyRecovered).not.toHaveBeenCalled();
  });
});
