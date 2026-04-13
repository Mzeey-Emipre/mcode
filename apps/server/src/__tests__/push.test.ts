import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addClient,
  removeClient,
  sessionCount,
  onSessionChange,
  _resetForTest,
} from "../transport/push";

/** Minimal WebSocket mock that satisfies the readyState/OPEN/send interface. */
function mockWs(): any {
  return { readyState: 1, OPEN: 1, send: vi.fn() };
}

describe("push session tracking", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("increments session count on addClient", () => {
    const ws = mockWs();
    addClient(ws);
    expect(sessionCount()).toBe(1);
  });

  it("decrements session count on removeClient", () => {
    const ws = mockWs();
    addClient(ws);
    removeClient(ws);
    expect(sessionCount()).toBe(0);
  });

  it("fires onSessionChange callback with new count", () => {
    const cb = vi.fn();
    const unsub = onSessionChange(cb);
    const ws = mockWs();
    addClient(ws);
    expect(cb).toHaveBeenCalledWith(1);
    removeClient(ws);
    expect(cb).toHaveBeenCalledWith(0);
    unsub();
  });

  it("unsub stops callback from firing", () => {
    const cb = vi.fn();
    const unsub = onSessionChange(cb);
    unsub();
    const ws = mockWs();
    addClient(ws);
    expect(cb).not.toHaveBeenCalled();
  });
});
