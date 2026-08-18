import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AUTOMATION_HEARTBEAT_INTERVAL_MS,
  BrowserAutomationHeartbeatPulse,
} from "../heartbeat-pulse.js";

describe("BrowserAutomationHeartbeatPulse", () => {
  it("keeps pulsing a background renderer from the Electron main clock", () => {
    vi.useFakeTimers();
    try {
      let destroyed: (() => void) | undefined;
      const sender = {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
        once: vi.fn((_event: "destroyed", callback: () => void) => {
          destroyed = callback;
        }),
      };
      const pulse = new BrowserAutomationHeartbeatPulse();

      pulse.subscribe(sender);
      expect(sender.send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(BROWSER_AUTOMATION_HEARTBEAT_INTERVAL_MS * 2);
      expect(sender.send).toHaveBeenCalledTimes(3);

      destroyed?.();
      vi.advanceTimersByTime(BROWSER_AUTOMATION_HEARTBEAT_INTERVAL_MS);
      expect(sender.send).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
