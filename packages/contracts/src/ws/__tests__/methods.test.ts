import { describe, expect, it } from "vitest";
import { MAX_THREAD_SUBSCRIPTIONS, WS_METHODS } from "../methods.js";

describe("thread switching WebSocket contracts", () => {
  it("registers bounded conversation.tail params and result", () => {
    const method = WS_METHODS()["conversation.tail"];

    expect(method.params.safeParse({ threadId: "thread-1", limit: 2 }).success).toBe(true);
    expect(method.params.safeParse({ threadId: "thread-1", limit: 3 }).success).toBe(false);
    expect(method.result.safeParse({ messages: [], hasMore: false }).success).toBe(true);
  });

  it("replaces the complete desired subscription set atomically", () => {
    const method = WS_METHODS()["push.setThreadSubscriptions"];

    expect(method.params.safeParse({ threadIds: ["thread-1", "thread-2"] }).success).toBe(true);
    expect(method.params.safeParse({ threadIds: ["thread-1", "thread-1"] }).success).toBe(false);
    expect(method.params.safeParse({ threadIds: Array.from({ length: MAX_THREAD_SUBSCRIPTIONS + 1 }, (_, index) => `thread-${index}`) }).success).toBe(false);
    expect(method.params.safeParse({ threadIds: [""] }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": { epoch: "00000000-0000-4000-8000-000000000001", sequence: 4 } },
    }).success).toBe(true);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": 4 },
    }).success).toBe(true);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": -1 },
    }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: { "thread-1": 1.5 },
    }).success).toBe(false);
    expect(method.params.safeParse({
      threadIds: ["thread-1"],
      cursors: Object.fromEntries(
        Array.from({ length: MAX_THREAD_SUBSCRIPTIONS + 1 }, (_, index) => [`thread-${index}`, index]),
      ),
    }).success).toBe(false);
  });

  it("parses structured hydration and replay results", () => {
    const method = WS_METHODS()["push.setThreadSubscriptions"];
    const result = {
      hydrationRequiredThreadIds: ["thread-1"],
      replayedThrough: { "thread-2": 12 },
    };

    const parsed = method.result.safeParse(result);

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    expect(parsed.data).toEqual(result);
  });

  it("rejects malformed subscription replay results", () => {
    const method = WS_METHODS()["push.setThreadSubscriptions"];

    expect(method.result.safeParse({
      hydrationRequiredThreadIds: ["thread-1"],
      replayedThrough: { "thread-2": 0 },
    }).success).toBe(false);
  });

  it("keeps legacy single-thread subscription methods available", () => {
    expect(WS_METHODS()["push.subscribeThread"]).toBeDefined();
    expect(WS_METHODS()["push.unsubscribeThread"]).toBeDefined();
  });
});
