import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeServerBusy } from "@/lib/desktop-power";
import {
  requestEnsureServerRunning,
  resetEnsureServerThrottleForTest,
} from "@/transport/ws-transport";

describe("computeServerBusy", () => {
  it("is idle with no running threads and no terminals", () => {
    expect(computeServerBusy(new Set(), {})).toBe(false);
  });

  it("is busy when any agent turn is running", () => {
    expect(computeServerBusy(new Set(["thread-1"]), {})).toBe(true);
  });

  it("is busy when any terminal session is open", () => {
    expect(computeServerBusy(new Set(), { "thread-1": [{ id: "pty-1" }] })).toBe(true);
  });

  it("ignores threads whose terminal list is empty", () => {
    expect(computeServerBusy(new Set(), { "thread-1": [] })).toBe(false);
  });

  it("is busy when both turns and terminals are active", () => {
    expect(
      computeServerBusy(new Set(["thread-1"]), { "thread-2": [{ id: "pty-1" }] }),
    ).toBe(true);
  });
});

describe("requestEnsureServerRunning throttle", () => {
  let ensureMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetEnsureServerThrottleForTest();
    ensureMock = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { desktopBridge?: unknown }).desktopBridge = {
      ensureServerRunning: ensureMock,
    };
  });

  afterEach(() => {
    delete (window as unknown as { desktopBridge?: unknown }).desktopBridge;
    resetEnsureServerThrottleForTest();
  });

  it("issues a request on the first call", () => {
    expect(requestEnsureServerRunning(100_000)).toBe(true);
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses calls within the 15s window", () => {
    expect(requestEnsureServerRunning(100_000)).toBe(true);
    expect(requestEnsureServerRunning(100_000 + 14_999)).toBe(false);
    expect(ensureMock).toHaveBeenCalledTimes(1);
  });

  it("allows a new request after the window elapses", () => {
    expect(requestEnsureServerRunning(100_000)).toBe(true);
    expect(requestEnsureServerRunning(100_000 + 15_000)).toBe(true);
    expect(ensureMock).toHaveBeenCalledTimes(2);
  });

  it("no-ops without desktopBridge (browser builds) but still consumes the window", () => {
    delete (window as unknown as { desktopBridge?: unknown }).desktopBridge;
    expect(requestEnsureServerRunning(100_000)).toBe(true);
    expect(ensureMock).not.toHaveBeenCalled();
  });
});
