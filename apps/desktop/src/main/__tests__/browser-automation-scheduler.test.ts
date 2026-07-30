import { describe, expect, it } from "vitest";
import {
  BrowserAutomationCancelledError,
  BrowserAutomationQueueFullError,
  BrowserAutomationScheduler,
} from "../browser-automation/scheduler.js";
import { OldestFirstRingBuffer } from "../browser-automation/ring-buffer.js";
import { redactBrowserDiagnosticUrl, redactBrowserText, redactBrowserUrl, redactBrowserValue } from "../browser-automation/redaction.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("BrowserAutomationScheduler", () => {
  it("preserves FIFO order within a tab", async () => {
    const scheduler = new BrowserAutomationScheduler(5, 8);
    const gate = deferred<void>();
    const order: number[] = [];
    const first = scheduler.enqueue("tab-a", async () => { await gate.promise; order.push(1); return 1; });
    const second = scheduler.enqueue("tab-a", async () => { order.push(2); return 2; });
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await expect(Promise.all([first.promise, second.promise])).resolves.toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("runs different tabs concurrently and enforces the global cap", async () => {
    const scheduler = new BrowserAutomationScheduler(2, 8);
    const gate = deferred<void>();
    let active = 0;
    let maximum = 0;
    const jobs = ["a", "b", "c"].map((key) => scheduler.enqueue(key, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active -= 1;
      return key;
    }).promise);
    await Promise.resolve();
    expect(scheduler.getCounters().active).toBe(2);
    gate.resolve();
    await expect(Promise.all(jobs)).resolves.toEqual(["a", "b", "c"]);
    expect(maximum).toBe(2);
  });

  it("cancels queued and active operations", async () => {
    const scheduler = new BrowserAutomationScheduler(1, 8);
    const active = scheduler.enqueue("a", async (signal) => {
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new BrowserAutomationCancelledError()), { once: true }));
      return 1;
    });
    const queued = scheduler.enqueue("a", async () => 2);
    active.cancel();
    queued.cancel();
    await expect(active.promise).rejects.toBeInstanceOf(BrowserAutomationCancelledError);
    await expect(queued.promise).rejects.toBeInstanceOf(BrowserAutomationCancelledError);
  });

  it("rejects work beyond the deterministic target queue bound", async () => {
    const scheduler = new BrowserAutomationScheduler(1, 1);
    const gate = deferred<void>();
    const first = scheduler.enqueue("a", () => gate.promise);
    const second = scheduler.enqueue("a", async () => undefined);
    const third = scheduler.enqueue("a", async () => undefined);
    await expect(third.promise).rejects.toBeInstanceOf(BrowserAutomationQueueFullError);
    gate.resolve();
    await first.promise;
    await second.promise;
  });
});

describe("browser automation bounds and redaction", () => {
  it("evicts oldest diagnostics deterministically under flood", () => {
    const ring = new OldestFirstRingBuffer<number>(200);
    for (let index = 0; index < 10_000; index += 1) ring.push(index);
    expect(ring.size).toBe(200);
    expect(ring.read(3)).toEqual([9_997, 9_998, 9_999]);
  });

  it("redacts URLs, bearer credentials, password fields, and nested token values", () => {
    expect(redactBrowserUrl("https://user:pass@example.test/a?token=secret&ok=1"))
      .toBe("https://example.test/a?token=%5BREDACTED%5D&ok=1");
    expect(redactBrowserDiagnosticUrl("https://example.test/a?ok=private#fragment"))
      .toBe("https://example.test/a");
    expect(redactBrowserText("Authorization: Bearer abc.def.ghi token=supersecret"))
      .not.toContain("supersecret");
    expect(redactBrowserText("access_token=one refreshToken=two session_id=three"))
      .toBe("access_token=[REDACTED] refreshToken=[REDACTED] session_id=[REDACTED]");
    expect(redactBrowserUrl("https://example.test/callback#access_token=secret&state=ok"))
      .toBe("https://example.test/callback#access_token=%5BREDACTED%5D&state=ok");
    expect(redactBrowserValue({ password: "visible", nested: { access_token: "also-visible" } }))
      .toEqual({ password: "[REDACTED]", nested: { access_token: "[REDACTED]" } });
  });

  it("bounds hostile recursive values", () => {
    let value: Record<string, unknown> = {};
    const root = value;
    for (let depth = 0; depth < 50; depth += 1) {
      const next: Record<string, unknown> = {};
      value.next = next;
      value = next;
    }
    expect(JSON.stringify(redactBrowserValue(root)).length).toBeLessThan(1_000);
  });
});
