import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortPush, type MessagePortLike } from "../transport/port-push";

/** Minimal mock matching the subset of MessagePort we use. */
function createMockPort(): MessagePortLike {
  return {
    postMessage: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  };
}

describe("PortPush", () => {
  let portPush: PortPush;

  beforeEach(() => {
    portPush = new PortPush();
  });

  it("does nothing when no port is attached", () => {
    // Should not throw
    portPush.send("agent.event", { type: "delta", threadId: "t1" });
  });

  it("sends structured clone message via attached port", () => {
    const port = createMockPort();
    portPush.attach(port);

    const data = { type: "delta", threadId: "t1", delta: "hello" };
    portPush.send("agent.event", data);

    expect(port.postMessage).toHaveBeenCalledWith({
      channel: "agent.event",
      data,
    });
  });

  it("stops sending after detach", () => {
    const port = createMockPort();
    portPush.attach(port);
    portPush.detach();

    portPush.send("agent.event", { type: "delta", threadId: "t1" });

    expect(port.postMessage).toHaveBeenCalledTimes(0);
  });

  it("closes port on detach", () => {
    const port = createMockPort();
    portPush.attach(port);
    portPush.detach();

    expect(port.close).toHaveBeenCalled();
  });

  it("reports active state", () => {
    expect(portPush.isActive).toBe(false);

    const port = createMockPort();
    portPush.attach(port);
    expect(portPush.isActive).toBe(true);

    portPush.detach();
    expect(portPush.isActive).toBe(false);
  });

  it("closes old port when reattaching a new one", () => {
    const port1 = createMockPort();
    const port2 = createMockPort();

    portPush.attach(port1);
    portPush.attach(port2);

    expect(port1.close).toHaveBeenCalled();
    expect(portPush.isActive).toBe(true);

    // New port receives messages, old one does not
    portPush.send("agent.event", { type: "delta" });
    expect(port2.postMessage).toHaveBeenCalledOnce();
    expect(port1.postMessage).not.toHaveBeenCalled();
  });

  it("no-ops when reattaching the same port instance", () => {
    const port = createMockPort();
    portPush.attach(port);
    portPush.attach(port);

    // close should NOT have been called (same instance)
    expect(port.close).not.toHaveBeenCalled();
    expect(portPush.isActive).toBe(true);
  });

  it("detaches on send failure and closes the broken port", () => {
    const port = createMockPort();
    vi.mocked(port.postMessage).mockImplementation(() => {
      throw new Error("port closed");
    });

    portPush.attach(port);
    portPush.send("agent.event", { type: "delta" });

    // Port should have been closed and detached
    expect(port.close).toHaveBeenCalled();
    expect(portPush.isActive).toBe(false);

    // Subsequent sends are no-ops
    portPush.send("agent.event", { type: "delta" });
    expect(port.postMessage).toHaveBeenCalledOnce(); // only the failed call
  });
});
