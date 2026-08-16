import { describe, expect, it, vi } from "vitest";
import {
  createShutdownCoordinator,
  EXPLICIT_SHUTDOWN_DEADLINE_MS,
} from "../shutdown-coordinator.js";

describe("createShutdownCoordinator", () => {
  it("exits with the current phase when a shutdown phase exceeds the deadline", async () => {
    let trigger: (() => void) | undefined;
    const exit = vi.fn(() => undefined as never);
    const onDeadline = vi.fn();
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const coordinator = createShutdownCoordinator({
      shutdown,
      exit,
      onDeadline,
      schedule: ((callback: () => void) => {
        trigger = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      cancel: vi.fn(),
    });

    coordinator.setPhase("shutdown cleanup worker");
    coordinator.requestShutdown();
    trigger?.();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(onDeadline).toHaveBeenCalledWith("shutdown cleanup worker");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("clears the watchdog when shutdown completes normally", async () => {
    const cancel = vi.fn();
    const shutdown = vi.fn(async () => undefined);
    const coordinator = createShutdownCoordinator({
      shutdown,
      cancel,
      schedule: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    });

    await coordinator.requestShutdown();

    expect(cancel).toHaveBeenCalledOnce();
    expect(EXPLICIT_SHUTDOWN_DEADLINE_MS).toBe(8_000);
  });
});
