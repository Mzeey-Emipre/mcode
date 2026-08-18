import { describe, expect, it, vi } from "vitest";
import { BrowserAutomationHostSupervisor } from "../browserAutomationHostSupervisor";

describe("BrowserAutomationHostSupervisor", () => {
  it("replaces a rejected lease once when concurrent heartbeat calls fail", async () => {
    let generation = 0;
    const register = vi.fn(async () => ({
      hostId: "host-1",
      generation: ++generation,
      desktopInstanceId: `desktop-${generation}`,
    }));
    const heartbeat = vi.fn()
      .mockRejectedValueOnce(new Error("Host registration is stale"))
      .mockRejectedValueOnce(new Error("Host registration is stale"))
      .mockResolvedValue(undefined);
    const onLeaseChanged = vi.fn();
    const supervisor = new BrowserAutomationHostSupervisor({
      register,
      heartbeat,
      onLeaseChanged,
      retryDelayMs: 1_000,
    });

    await supervisor.start();
    await Promise.all([supervisor.pulse(), supervisor.pulse()]);

    expect(register).toHaveBeenCalledTimes(2);
    expect(supervisor.currentLease).toMatchObject({ generation: 2, desktopInstanceId: "desktop-2" });
    expect(onLeaseChanged.mock.calls.map(([lease]) => lease?.generation ?? null)).toEqual([1, null, 2]);
  });

  it("does not retry a failed registration after it stops", async () => {
    vi.useFakeTimers();
    try {
      const register = vi.fn().mockRejectedValue(new Error("Transport unavailable"));
      const supervisor = new BrowserAutomationHostSupervisor({
        register,
        heartbeat: vi.fn(),
        onLeaseChanged: vi.fn(),
        retryDelayMs: 1_000,
      });

      await supervisor.start();
      supervisor.stop();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(register).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
