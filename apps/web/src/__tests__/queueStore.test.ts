import { describe, it, expect, beforeEach } from "vitest";
import { useQueueStore } from "@/stores/queueStore";
import type { QueuedMessage } from "@/stores/queueStore";

const T = "thread-a";

function basePayload(content: string): Omit<QueuedMessage, "id" | "queuedAt"> {
  return {
    content,
    displayContent: content,
    attachments: [],
    model: "claude-sonnet-4-6",
    permissionMode: "ASK" as QueuedMessage["permissionMode"],
  };
}

function seed(contents: string[]): QueuedMessage[] {
  const { enqueue } = useQueueStore.getState();
  contents.forEach((c) => enqueue(T, basePayload(c)));
  return useQueueStore.getState().queues[T] ?? [];
}

describe("queueStore", () => {
  beforeEach(() => {
    useQueueStore.setState({
      queues: {},
      inFlightQueuedMessages: {},
      disposedQueuedMessages: {},
      queueGenerations: {},
      toast: null,
    });
  });

  it("queues successful messages silently but reports a full queue", () => {
    expect(useQueueStore.getState().enqueue(T, basePayload("first"))).toBe(true);
    expect(useQueueStore.getState().toast).toBeNull();

    seed(Array.from({ length: 19 }, (_, index) => `queued-${index}`));
    expect(useQueueStore.getState().enqueue(T, basePayload("overflow"))).toBe(false);
    expect(useQueueStore.getState().toast).toBe("Queue full");
  });

  describe("editMessage", () => {
    it("rewrites content and displayContent for the targeted id, keeps position", () => {
      const [, b] = seed(["alpha", "beta", "gamma"]);
      useQueueStore.getState().editMessage(T, b.id, "beta-edited");
      const q = useQueueStore.getState().queues[T];
      expect(q.map((m) => m.content)).toEqual(["alpha", "beta-edited", "gamma"]);
      expect(q[1].displayContent).toBe("beta-edited");
      // Other fields preserved
      expect(q[1].model).toBe("claude-sonnet-4-6");
    });

    it("accepts an explicit displayContent override", () => {
      const [a] = seed(["alpha"]);
      useQueueStore.getState().editMessage(T, a.id, "raw", "shown");
      const q = useQueueStore.getState().queues[T];
      expect(q[0].content).toBe("raw");
      expect(q[0].displayContent).toBe("shown");
    });

    it("is a no-op when the messageId is no longer queued", () => {
      seed(["alpha"]);
      const before = useQueueStore.getState().queues[T];
      useQueueStore.getState().editMessage(T, "missing", "ignored");
      expect(useQueueStore.getState().queues[T]).toBe(before);
    });
  });

  describe("moveMessage", () => {
    it("moves an item forward and clamps the target index", () => {
      const [a, b, c] = seed(["a", "b", "c"]);
      useQueueStore.getState().moveMessage(T, a.id, 99);
      expect(useQueueStore.getState().queues[T].map((m) => m.id)).toEqual([
        b.id,
        c.id,
        a.id,
      ]);
    });

    it("moves an item backward to the requested index", () => {
      const [a, b, c] = seed(["a", "b", "c"]);
      useQueueStore.getState().moveMessage(T, c.id, 0);
      expect(useQueueStore.getState().queues[T].map((m) => m.id)).toEqual([
        c.id,
        a.id,
        b.id,
      ]);
    });

    it("is a no-op for single-item queues or unchanged positions", () => {
      const [solo] = seed(["only"]);
      const beforeSingle = useQueueStore.getState().queues[T];
      useQueueStore.getState().moveMessage(T, solo.id, 0);
      expect(useQueueStore.getState().queues[T]).toBe(beforeSingle);
    });
  });

  describe("insertAt", () => {
    it("places a new message at the requested index, shifting siblings", () => {
      const [a, b, c] = seed(["a", "b", "c"]);
      const ok = useQueueStore.getState().insertAt(T, 1, basePayload("inserted"));
      expect(ok).toBe(true);
      const ids = useQueueStore.getState().queues[T].map((m) => m.content);
      expect(ids).toEqual(["a", "inserted", "b", "c"]);
      // Original ids preserved
      expect(useQueueStore.getState().queues[T][0].id).toBe(a.id);
      expect(useQueueStore.getState().queues[T][2].id).toBe(b.id);
      expect(useQueueStore.getState().queues[T][3].id).toBe(c.id);
    });

    it("clamps the index to the current queue length", () => {
      seed(["a"]);
      useQueueStore.getState().insertAt(T, 99, basePayload("tail"));
      expect(useQueueStore.getState().queues[T].map((m) => m.content)).toEqual(["a", "tail"]);
    });

    it("returns false and skips insertion when the queue is full", () => {
      const contents = Array.from({ length: 20 }, (_, i) => `m${i}`);
      seed(contents);
      const ok = useQueueStore.getState().insertAt(T, 0, basePayload("overflow"));
      expect(ok).toBe(false);
      expect(useQueueStore.getState().queues[T]).toHaveLength(20);
    });
  });

  describe("popMessage", () => {
    it("removes the message from the queue and returns it", () => {
      const [a, b] = seed(["alpha", "beta"]);
      const popped = useQueueStore.getState().popMessage(T, a.id);
      expect(popped?.id).toBe(a.id);
      expect(useQueueStore.getState().queues[T].map((m) => m.id)).toEqual([b.id]);
    });

    it("returns undefined and leaves the queue intact for unknown ids", () => {
      seed(["alpha"]);
      const before = useQueueStore.getState().queues[T];
      const popped = useQueueStore.getState().popMessage(T, "missing");
      expect(popped).toBeUndefined();
      expect(useQueueStore.getState().queues[T]).toBe(before);
    });
  });
});
