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
});
