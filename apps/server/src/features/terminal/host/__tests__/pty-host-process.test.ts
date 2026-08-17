import { describe, expect, it, vi } from "vitest";
import { PtyHostMessageQueue } from "../pty-host-process.js";

describe("PtyHostMessageQueue", () => {
  it("rejects messages beyond the retained-record limit", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = vi.fn(async () => blocked);
    const queue = new PtyHostMessageQueue(handle, async () => undefined);

    for (let index = 0; index < 256; index += 1) {
      expect(queue.enqueue({ index })).toBe(true);
    }
    expect(queue.enqueue({ index: 256 })).toBe(false);

    release();
    await queue.idle();
    expect(handle).toHaveBeenCalledTimes(256);
    expect(queue.pendingBytes).toBe(0);
  });

  it("rejects aggregate queued data beyond one MiB", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new PtyHostMessageQueue(
      async () => blocked,
      async () => undefined,
    );
    const message = { data: "x".repeat(100_000) };

    for (let index = 0; index < 10; index += 1) {
      expect(queue.enqueue(message)).toBe(true);
    }
    expect(queue.enqueue(message)).toBe(false);

    release();
    await queue.idle();
  });
});
