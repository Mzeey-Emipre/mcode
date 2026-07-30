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
  });

  it("keeps legacy single-thread subscription methods available", () => {
    expect(WS_METHODS()["push.subscribeThread"]).toBeDefined();
    expect(WS_METHODS()["push.unsubscribeThread"]).toBeDefined();
  });
});
