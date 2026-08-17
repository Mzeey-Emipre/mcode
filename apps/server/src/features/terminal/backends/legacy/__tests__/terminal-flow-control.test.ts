import { describe, it, expect, vi } from "vitest";
import { TerminalFlowControl } from "../terminal-flow-control.js";

describe("TerminalFlowControl", () => {
  it("starts un-paused and forwards bytes through the sink", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.push(0, new Uint8Array([1, 2, 3]));
    expect(sink).toHaveBeenCalledTimes(1);
    // sink receives (seq, bytes)
    expect(sink.mock.calls[0][0]).toBe(0);
    expect(sink.mock.calls[0][1]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("buffers bytes while paused and drains them on resume", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.pause("client-request");
    fc.push(0, new Uint8Array([1, 2]));
    fc.push(1, new Uint8Array([3, 4]));
    expect(sink).not.toHaveBeenCalled();
    fc.resume();
    // Seq numbers preserved through the ring; bytes arrive in order.
    expect(sink.mock.calls.map((c) => [c[0], Array.from(c[1] as Uint8Array)])).toEqual([
      [0, [1, 2]],
      [1, [3, 4]],
    ]);
  });

  it("drops oldest buffered chunks only after cap is exceeded and records dropped bytes", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 10, lowBytes: 5, bufferCapBytes: 8 });
    fc.pause("socket-buffered");
    fc.push(0, new Uint8Array([1, 2, 3, 4, 5])); // 5 bytes, fits in cap
    fc.push(1, new Uint8Array([6, 7, 8, 9]));   // would bring total to 9 > 8 → drop oldest
    expect(fc.droppedBytes).toBeGreaterThan(0);
    fc.resume();
    const drained = sink.mock.calls.flatMap((c) => Array.from(c[1] as Uint8Array));
    expect(drained.length).toBeLessThanOrEqual(8);
  });

  it("seq is assigned at push time so evicted chunks leave visible gaps", () => {
    // The surviving chunk should carry seq=1 even though seq=0 was evicted.
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 10, lowBytes: 5, bufferCapBytes: 4 });
    fc.pause("socket-buffered");
    fc.push(0, new Uint8Array([1, 2, 3, 4, 5])); // 5 bytes > cap=4 → evicted immediately
    fc.push(1, new Uint8Array([1, 2, 3]));        // 3 bytes, fits
    fc.resume();
    // seq=0 was evicted; only seq=1 arrives at the sink
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toBe(1);
    expect(fc.droppedBytes).toBeGreaterThan(0);
  });

  it("is idempotent for pause/resume", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.pause("client-request");
    fc.pause("socket-buffered"); // second pause is fine
    fc.resume(); // clears both
    fc.resume(); // no-op
    fc.push(0, new Uint8Array([1]));
    expect(sink).toHaveBeenCalledOnce();
  });

  it("release() removes one source and drains only when both are clear", () => {
    const sink = vi.fn();
    const fc = new TerminalFlowControl({ sink, highBytes: 100, lowBytes: 40 });
    fc.pause("client-request");
    fc.pause("socket-buffered");
    fc.push(0, new Uint8Array([42]));
    fc.release("client-request"); // still held by socket-buffered
    expect(sink).not.toHaveBeenCalled();
    fc.release("socket-buffered"); // now clear → drain
    expect(sink).toHaveBeenCalledOnce();
  });
});
