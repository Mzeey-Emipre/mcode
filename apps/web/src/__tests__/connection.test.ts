import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWsTransport } from "../transport/ws-transport";

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  send(_data: string) {}

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let mockWsInstance: MockWebSocket;

beforeEach(() => {
  vi.stubGlobal(
    "WebSocket",
    new Proxy(MockWebSocket, {
      construct(Target) {
        const instance = new Target();
        mockWsInstance = instance;
        return instance;
      },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitForConnection", () => {
  it("resolves when WebSocket opens within timeout", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    const connectPromise = transport.waitForConnection(5000);
    mockWsInstance.simulateOpen();
    await expect(connectPromise).resolves.toBeUndefined();
    transport.close();
  });

  it("rejects when WebSocket does not open within timeout", async () => {
    vi.useFakeTimers();
    const transport = createWsTransport("ws://localhost:1234");
    const connectPromise = transport.waitForConnection(3000);
    vi.advanceTimersByTime(3000);
    await expect(connectPromise).rejects.toThrow(
      "Could not connect to server at ws://localhost:1234",
    );
    transport.close();
    vi.useRealTimers();
  });
});

describe("onStatusChange", () => {
  it("fires 'connected' when WebSocket opens", () => {
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    expect(statusSpy).toHaveBeenCalledWith("connected");
    transport.close();
  });

  it("fires 'reconnecting' when WebSocket closes and reconnect is scheduled", () => {
    vi.useFakeTimers();
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    mockWsInstance.simulateClose();
    expect(statusSpy).toHaveBeenCalledWith("reconnecting");
    transport.close();
    vi.useRealTimers();
  });

  it("does not fire 'reconnecting' when transport is intentionally closed", () => {
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    transport.close();
    expect(statusSpy).not.toHaveBeenCalledWith("reconnecting");
  });
});
