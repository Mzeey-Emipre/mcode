import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortEventSource } from "../transport/port-events";
import { pushEmitter, suppressedPushChannels } from "../transport/ws-transport";

vi.mock("../transport/ws-transport", () => ({
  pushEmitter: {
    emit: vi.fn(),
  },
  suppressedPushChannels: new Set<string>(),
}));

describe("PortEventSource", () => {
  let source: PortEventSource;

  beforeEach(() => {
    vi.clearAllMocks();
    suppressedPushChannels.clear();
    source = new PortEventSource();
  });

  it("is inactive by default", () => {
    expect(source.isActive).toBe(false);
  });

  it("becomes active when callback is invoked with data", () => {
    const callback = source.getCallback();
    callback({ channel: "agent.event", data: { type: "delta" } });

    expect(source.isActive).toBe(true);
  });

  it("forwards events to pushEmitter", () => {
    const callback = source.getCallback();
    const data = { type: "delta", threadId: "t1", delta: "hello" };
    callback({ channel: "agent.event", data });

    expect(pushEmitter.emit).toHaveBeenCalledWith("agent.event", data);
  });

  it("forwards multiple channels", () => {
    const callback = source.getCallback();

    callback({ channel: "agent.event", data: { type: "delta" } });
    callback({ channel: "terminal.data", data: { ptyId: "p1", data: "output" } });

    expect(pushEmitter.emit).toHaveBeenCalledTimes(2);
    expect(pushEmitter.emit).toHaveBeenCalledWith("agent.event", { type: "delta" });
    expect(pushEmitter.emit).toHaveBeenCalledWith("terminal.data", { ptyId: "p1", data: "output" });
  });

  it("ignores messages without channel", () => {
    const callback = source.getCallback();
    callback({ notAChannel: true });

    expect(pushEmitter.emit).not.toHaveBeenCalled();
  });

  it("reports suppressed channels", () => {
    const callback = source.getCallback();
    callback({ channel: "agent.event", data: {} });

    expect(source.suppressedChannels).toContain("agent.event");
  });

  it("adds to suppressedPushChannels in ws-transport", () => {
    const callback = source.getCallback();
    callback({ channel: "agent.event", data: {} });

    expect(suppressedPushChannels.has("agent.event")).toBe(true);
  });
});
