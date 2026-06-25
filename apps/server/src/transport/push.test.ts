import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  addClient,
  broadcast,
  broadcastTerminalData,
  subscribeClientToThread,
  unsubscribeClientFromThread,
  _resetForTest,
} from "./push.js";
import { decodeTerminalDataFrame } from "@mcode/contracts";
import {
  createPassThroughTransportPayloadValidator,
  createValidatingTransportPayloadValidator,
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
} from "./payload-validation.js";

function fakeOpenSocket(received: Array<{ buf: Buffer; binary: boolean }>): WebSocket {
  const ws: Partial<WebSocket> = {
    readyState: 1, // OPEN
    OPEN: 1,
    send: ((data: unknown, opts?: { binary?: boolean }) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as Uint8Array);
      received.push({ buf, binary: !!opts?.binary });
    }) as WebSocket["send"],
  };
  return ws as WebSocket;
}

describe("broadcastTerminalData", () => {
  beforeEach(() => {
    _resetForTest();
    resetTransportPayloadValidatorForTest();
  });
  afterEach(() => {
    _resetForTest();
    resetTransportPayloadValidatorForTest();
  });

  it("sends a binary frame to every connected client", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(a));
    addClient(fakeOpenSocket(b));

    const payload = new Uint8Array([0x41, 0x42, 0x43]); // ABC
    broadcastTerminalData("pty-1", 42, payload);

    expect(a).toHaveLength(1);
    expect(a[0].binary).toBe(true);
    const decoded = decodeTerminalDataFrame(new Uint8Array(a[0].buf));
    expect(decoded).toEqual({ ptyId: "pty-1", seq: 42, payload });
    expect(b).toHaveLength(1);
    expect(b[0].binary).toBe(true);
  });

  it("preserves byte boundaries for multi-byte UTF-8", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(received));
    const payload = new Uint8Array([0xe4, 0xbd, 0xa0]); // "你" in UTF-8
    broadcastTerminalData("pty-1", 0, payload);
    const decoded = decodeTerminalDataFrame(new Uint8Array(received[0].buf));
    expect(decoded.payload).toEqual(payload);
  });
});

describe("broadcast", () => {
  beforeEach(() => {
    _resetForTest();
    resetTransportPayloadValidatorForTest();
  });
  afterEach(() => {
    _resetForTest();
    resetTransportPayloadValidatorForTest();
  });

  it("routes thread-scoped events only to clients subscribed to that thread", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    const wsA = fakeOpenSocket(a);
    const wsB = fakeOpenSocket(b);
    addClient(wsA);
    addClient(wsB);
    subscribeClientToThread(wsA, "thread-a");
    subscribeClientToThread(wsB, "thread-b");

    broadcast("agent.event", {
      type: "textDelta",
      threadId: "thread-a",
      delta: "hello",
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect(JSON.parse(a[0].buf.toString("utf-8")).data.threadId).toBe("thread-a");
  });

  it("stops routing after a client unsubscribes from a thread", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    const ws = fakeOpenSocket(received);
    addClient(ws);
    subscribeClientToThread(ws, "thread-a");
    unsubscribeClientFromThread(ws, "thread-a");

    broadcast("agent.event", {
      type: "textDelta",
      threadId: "thread-a",
      delta: "hello",
    });

    expect(received).toHaveLength(0);
  });

  it("broadcasts threadless events to every client", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(a));
    addClient(fakeOpenSocket(b));

    broadcast("skills.changed", {});

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("broadcasts thread metadata events to clients subscribed to other threads", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    const wsA = fakeOpenSocket(a);
    const wsB = fakeOpenSocket(b);
    addClient(wsA);
    addClient(wsB);
    subscribeClientToThread(wsA, "thread-a");
    subscribeClientToThread(wsB, "thread-b");

    broadcast("thread.checkoutChanged", {
      threadId: "thread-a",
      workspaceId: "ws-1",
      branch: "feat/thread",
      checkoutState: "named",
      baseBranch: null,
      prNumber: null,
      prStatus: null,
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(JSON.parse(b[0].buf.toString("utf-8")).data.threadId).toBe("thread-a");
  });

  it("lets tests swap validating and pass-through payload adapters", () => {
    const validating: Array<{ buf: Buffer; binary: boolean }> = [];
    const validatingWs = fakeOpenSocket(validating);
    addClient(validatingWs);
    subscribeClientToThread(validatingWs, "thread-a");
    setTransportPayloadValidatorForTest(createValidatingTransportPayloadValidator());

    broadcast("thread.status", { threadId: "thread-a", status: "not-a-status" });
    expect(validating).toHaveLength(0);

    _resetForTest();
    const passThrough: Array<{ buf: Buffer; binary: boolean }> = [];
    const passThroughWs = fakeOpenSocket(passThrough);
    addClient(passThroughWs);
    subscribeClientToThread(passThroughWs, "thread-a");
    setTransportPayloadValidatorForTest(createPassThroughTransportPayloadValidator());

    broadcast("thread.status", { threadId: "thread-a", status: "not-a-status" });
    expect(passThrough).toHaveLength(1);
  });
});
