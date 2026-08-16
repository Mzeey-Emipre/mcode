import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  addClient,
  broadcast,
  broadcastTerminalData,
  sendToClient,
  setClientThreadSubscriptions,
  subscribeClientToThread,
  unsubscribeClientFromThread,
  _resetForTest,
} from "../push.js";
import { decodeTerminalDataFrame } from "@mcode/contracts";
import {
  createPassThroughTransportPayloadValidator,
  createValidatingTransportPayloadValidator,
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
} from "../payload-validation.js";

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

  it("routes canonical batches only to clients subscribed to their thread", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    const wsA = fakeOpenSocket(a);
    const wsB = fakeOpenSocket(b);
    addClient(wsA);
    addClient(wsB);
    subscribeClientToThread(wsA, "thread-a");
    subscribeClientToThread(wsB, "thread-b");

    broadcast("agent.canonical", {
      threadId: "thread-a",
      events: [{
        eventId: "event-a",
        routing: {
          threadId: "thread-a",
          turnId: "turn-a",
          executionId: "00000000-0000-4000-8000-000000000001",
        },
        sourceProviderId: "codex",
        sourceIdentities: [],
        acceptedSequence: 1,
        durableRevision: 1,
        serverTimestamps: {
          acceptedAt: "2026-08-09T20:00:00.000Z",
          persistedAt: "2026-08-09T20:00:00.000Z",
        },
        payload: { type: "turn.started", startedAt: "2026-08-09T20:00:00.000Z" },
      }],
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("routes live file effects only to clients subscribed to that thread", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    const wsA = fakeOpenSocket(a);
    const wsB = fakeOpenSocket(b);
    addClient(wsA);
    addClient(wsB);
    subscribeClientToThread(wsA, "thread-a");
    subscribeClientToThread(wsB, "thread-b");

    broadcast("turn.fileEffectsUpdated", {
      threadId: "thread-a",
      turnId: "turn-1",
      summary: { revision: 1, fileCount: 0, additions: 0, deletions: 0, effects: [] },
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
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

  it("atomically replaces all thread subscriptions", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    const ws = fakeOpenSocket(received);
    addClient(ws);
    subscribeClientToThread(ws, "thread-old");

    setClientThreadSubscriptions(ws, ["thread-new"]);

    broadcast("agent.event", {
      type: "textDelta",
      threadId: "thread-old",
      delta: "old",
    });
    broadcast("agent.event", {
      type: "textDelta",
      threadId: "thread-new",
      delta: "new",
    });

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0].buf.toString("utf-8")).data.threadId).toBe("thread-new");
  });

  it("assigns ordered sequences and replays retained events before live delivery", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    broadcast("agent.event", { type: "textDelta", threadId: "thread-replay", delta: "one" });
    broadcast("agent.event", { type: "textDelta", threadId: "thread-replay", delta: "two" });
    const ws = fakeOpenSocket(received);
    addClient(ws);

    const result = setClientThreadSubscriptions(ws, ["thread-replay"], { "thread-replay": 0 });
    expect(result).toEqual({ hydrationRequiredThreadIds: [], replayedThrough: { "thread-replay": 2 } });
    broadcast("agent.event", { type: "textDelta", threadId: "thread-replay", delta: "three" });

    expect(received.map((entry) => JSON.parse(entry.buf.toString("utf-8")).data.sequence)).toEqual([1, 2, 3]);
  });

  it("does not replay history for legacy subscription calls without cursors", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    broadcast("agent.event", { type: "textDelta", threadId: "thread-legacy", delta: "old" });
    const ws = fakeOpenSocket(received);
    addClient(ws);
    setClientThreadSubscriptions(ws, ["thread-legacy"]);
    expect(received).toHaveLength(0);
  });

  it("reports hydration when a cursor falls behind the bounded journal", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    for (let i = 0; i < 257; i++) {
      broadcast("agent.event", { type: "textDelta", threadId: "thread-gap", delta: String(i) });
    }
    const ws = fakeOpenSocket(received);
    addClient(ws);
    const result = setClientThreadSubscriptions(ws, ["thread-gap"], { "thread-gap": 0 });
    expect(result.hydrationRequiredThreadIds).toEqual(["thread-gap"]);
    expect(received).toHaveLength(0);
  });

  it("reports hydration for a cursor from another server epoch without replay", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    broadcast("agent.event", { type: "textDelta", threadId: "thread-epoch", delta: "one" });
    const ws = fakeOpenSocket(received);
    addClient(ws);
    const result = setClientThreadSubscriptions(ws, ["thread-epoch"], {
      "thread-epoch": { epoch: "00000000-0000-4000-8000-000000000001", sequence: 0 },
    });
    expect(result.hydrationRequiredThreadIds).toEqual(["thread-epoch"]);
    expect(received).toHaveLength(0);
  });

  it("clears all thread subscriptions when replacing with an empty set", () => {
    const received: Array<{ buf: Buffer; binary: boolean }> = [];
    const ws = fakeOpenSocket(received);
    addClient(ws);
    subscribeClientToThread(ws, "thread-a");

    setClientThreadSubscriptions(ws, []);
    broadcast("agent.event", {
      type: "textDelta",
      threadId: "thread-a",
      delta: "ignored",
    });

    expect(received).toHaveLength(0);
  });

  it("broadcasts threadless events to every client", () => {
    const a: Array<{ buf: Buffer; binary: boolean }> = [];
    const b: Array<{ buf: Buffer; binary: boolean }> = [];
    addClient(fakeOpenSocket(a));
    addClient(fakeOpenSocket(b));

    broadcast("skills.changed", { providerIds: ["claude", "copilot", "cursor"] });

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

describe("sendToClient", () => {
  beforeEach(() => {
    _resetForTest();
    resetTransportPayloadValidatorForTest();
  });
  afterEach(() => {
    _resetForTest();
    resetTransportPayloadValidatorForTest();
  });

  it("delivers a browser request to one registered socket without broadcasting", () => {
    const first: Array<{ buf: Buffer; binary: boolean }> = [];
    const second: Array<{ buf: Buffer; binary: boolean }> = [];
    const firstSocket = fakeOpenSocket(first);
    addClient(firstSocket);
    addClient(fakeOpenSocket(second));

    expect(sendToClient(firstSocket, "browserAutomation.request", {
      hostId: "host-a",
      generation: 1,
      dispatch: {
        scope: { workspaceId: "workspace-a", threadId: "thread-a", providerSessionId: "provider-a", providerInstanceId: "mcode-a" },
        connection: { desktopInstanceId: "desktop-a", windowId: 1, connectionGeneration: 1, targetGeneration: 0 },
        target: {
          desktopInstanceId: "desktop-a",
          windowId: 1,
          connectionGeneration: 1,
          threadId: "thread-a",
          tabId: "tab-a",
          targetGeneration: 0,
          active: true,
          focused: true,
          lastUsedAt: 10,
        },
        request: {
          contractVersion: 1,
          workspaceId: "workspace-a",
          threadId: "thread-a",
          providerSessionId: "provider-a",
          providerInstanceId: "mcode-a",
          requestId: "request-a",
          sequence: 1,
          deadline: 100,
          expectedControlEpoch: 0,
          operation: "status",
          args: {},
        },
      },
    })).toBe(true);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("reports a synchronous socket delivery failure without throwing", () => {
    const ws = {
      readyState: 1,
      OPEN: 1,
      send: () => { throw new Error("closed during send"); },
    } as unknown as WebSocket;
    addClient(ws);
    expect(sendToClient(ws, "browserAutomation.cancel", {
      hostId: "host-a",
      generation: 1,
      target: {
        desktopInstanceId: "desktop-a",
        windowId: 1,
        connectionGeneration: 1,
        threadId: "thread-a",
        tabId: "tab-a",
        targetGeneration: 0,
        active: true,
        focused: true,
        lastUsedAt: 10,
      },
      requestId: "request-a",
      sequence: 1,
      reason: "deadline-exceeded",
    })).toBe(false);
  });
});
