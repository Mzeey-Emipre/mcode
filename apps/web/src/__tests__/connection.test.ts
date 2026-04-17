import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWsTransport } from "../transport/ws-transport";

class MockWebSocket {
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }

  send(_data: string) {}

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
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

describe("4001 auth failure handling", () => {
  it("fires 'authFailed' status when closed with code 4001", () => {
    vi.useFakeTimers();
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    mockWsInstance.simulateClose(4001);
    expect(statusSpy).toHaveBeenCalledWith("authFailed");
    expect(statusSpy).not.toHaveBeenCalledWith("reconnecting");
    transport.close();
    vi.useRealTimers();
  });

  it("fires 'reconnecting' for non-4001 close codes", () => {
    vi.useFakeTimers();
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    mockWsInstance.simulateClose(1006);
    expect(statusSpy).toHaveBeenCalledWith("reconnecting");
    expect(statusSpy).not.toHaveBeenCalledWith("authFailed");
    transport.close();
    vi.useRealTimers();
  });

  it("reconnects immediately after 4001 close without waiting", async () => {
    vi.useFakeTimers();

    // Track each reconnect attempt's URL
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: vi.fn(),
      discoverServerUrl: async () => "ws://localhost:1234",
    });

    mockWsInstance.simulateOpen();

    // Grab initial reconnect delay by triggering a 4001 close (immediate reconnect)
    const firstInstance = mockWsInstance;
    firstInstance.simulateClose(4001);

    // With immediate=true, the reconnect fires at delay=0
    await vi.advanceTimersByTimeAsync(0);

    // A new WebSocket should have been created immediately
    const secondInstance = mockWsInstance;
    expect(secondInstance).not.toBe(firstInstance);

    transport.close();
    vi.useRealTimers();
  });

  it("calls discoverServerUrl on auth failure reconnect", async () => {
    vi.useFakeTimers();
    let discoverCalled = false;
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: vi.fn(),
      discoverServerUrl: async () => {
        discoverCalled = true;
        return "ws://localhost:5678";
      },
    });

    mockWsInstance.simulateOpen();
    mockWsInstance.simulateClose(4001);

    // Auth failure triggers immediate reconnect (delay=0)
    await vi.advanceTimersByTimeAsync(0);

    expect(discoverCalled).toBe(true);

    transport.close();
    vi.useRealTimers();
  });
});
