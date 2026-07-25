import { describe, it, expect } from "vitest";
import {
  TerminalReplayBuffer,
  replayCapBytesForScrollback,
  REPLAY_BYTES_PER_LINE,
  REPLAY_BUFFER_MIN_CAP_BYTES,
  REPLAY_BUFFER_MAX_CAP_BYTES,
} from "../terminal-replay-buffer.js";

describe("TerminalReplayBuffer", () => {
  it("starts empty", () => {
    const buf = new TerminalReplayBuffer(1024);
    expect(buf.replay(0)).toEqual({ chunks: [], gapped: false });
  });

  it("records and replays a single chunk", () => {
    const buf = new TerminalReplayBuffer(1024);
    const bytes = new Uint8Array([1, 2, 3]);
    buf.record(5, bytes);
    const result = buf.replay(4);
    expect(result.gapped).toBe(false);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.seq).toBe(5);
    expect(result.chunks[0]!.bytes).toEqual(bytes);
  });

  it("replay returns only chunks after lastSeq", () => {
    const buf = new TerminalReplayBuffer(1024);
    buf.record(1, new Uint8Array([1]));
    buf.record(2, new Uint8Array([2]));
    buf.record(3, new Uint8Array([3]));
    const result = buf.replay(1);
    expect(result.gapped).toBe(false);
    expect(result.chunks.map((c) => c.seq)).toEqual([2, 3]);
  });

  it("replay(0) returns all chunks", () => {
    const buf = new TerminalReplayBuffer(1024);
    buf.record(1, new Uint8Array([10]));
    buf.record(2, new Uint8Array([20]));
    buf.record(3, new Uint8Array([30]));
    const result = buf.replay(0);
    expect(result.gapped).toBe(false);
    expect(result.chunks.map((c) => c.seq)).toEqual([1, 2, 3]);
  });

  it("gapped=true when lastSeq is before oldest retained after eviction", () => {
    // cap=10 bytes; push enough to evict seq=1 so it's no longer retained
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6)); // 6 bytes
    buf.record(2, new Uint8Array(6)); // 12 > 10 → seq=1 evicted
    const result = buf.replay(0); // ask for everything including seq=0/1
    expect(result.gapped).toBe(true);
  });

  it("evicts oldest chunks when cap exceeded", () => {
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6).fill(0xaa)); // 6 bytes
    buf.record(2, new Uint8Array(6).fill(0xbb)); // 12 total > 10 → seq=1 evicted
    const result = buf.replay(0);
    // Only seq=2 should survive
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.seq).toBe(2);
  });

  it("bufferedBytes never exceeds cap after eviction", () => {
    const cap = 20;
    const buf = new TerminalReplayBuffer(cap);
    for (let i = 0; i < 10; i++) {
      buf.record(i, new Uint8Array(8).fill(i));
    }
    expect(buf.bufferedBytes).toBeLessThanOrEqual(cap);
  });

  it("droppedBytes accumulates correctly", () => {
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6)); // 6 bytes stored
    buf.record(2, new Uint8Array(6)); // 6 bytes causes seq=1 (6 bytes) to be evicted
    expect(buf.droppedBytes).toBe(6);
  });

  it("clear() empties the buffer", () => {
    const buf = new TerminalReplayBuffer(1024);
    buf.record(1, new Uint8Array([1, 2, 3]));
    buf.clear();
    const result = buf.replay(0);
    expect(result.chunks).toEqual([]);
  });

  it("replay after clear returns gapped=false", () => {
    const buf = new TerminalReplayBuffer(10);
    buf.record(1, new Uint8Array(6));
    buf.record(2, new Uint8Array(6)); // triggers eviction → droppedBytes > 0
    buf.clear();
    // After clear the slate is clean — not a gap, just empty
    const result = buf.replay(0);
    expect(result.gapped).toBe(false);
  });

  it("compaction: head pointer doesn't grow unboundedly", () => {
    // Each chunk is 1 byte so all 2000 fit within a 4 KB cap.
    // Verify the backing array stays bounded rather than accumulating a huge
    // ghost-head prefix.
    const buf = new TerminalReplayBuffer(4096);
    for (let i = 0; i < 2000; i++) {
      buf.record(i, new Uint8Array([i & 0xff]));
    }
    // All 2000 chunks fit (2000 bytes < 4096) — replay should return all.
    const result = buf.replay(-1);
    expect(result.gapped).toBe(false);
    expect(result.chunks.length).toBe(2000);
    // Compaction fires when head > 1024 AND head * 2 >= buffer.length, so the
    // ghost-head prefix is at most half the backing array at compaction time.
    // Upper bound 2000 * 2 is conservative: covers the worst-case half-prefix
    // that exists just before the next compaction would trigger.
    expect(buf.bufferLength).toBeLessThanOrEqual(2000 * 2);
  });

  it("seq=0 is valid — record(0, bytes) works, replay(-1) returns it", () => {
    const buf = new TerminalReplayBuffer(1024);
    const bytes = new Uint8Array([42]);
    buf.record(0, bytes);
    const result = buf.replay(-1);
    expect(result.gapped).toBe(false);
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.seq).toBe(0);
    expect(result.chunks[0]!.bytes).toEqual(bytes);
  });

  describe("setCap", () => {
    it("cap getter reflects the constructor value and setCap updates it", () => {
      const buf = new TerminalReplayBuffer(1024);
      expect(buf.cap).toBe(1024);
      buf.setCap(2048);
      expect(buf.cap).toBe(2048);
    });

    it("lowering the cap evicts oldest chunks down to the new limit", () => {
      const buf = new TerminalReplayBuffer(100);
      buf.record(1, new Uint8Array(20));
      buf.record(2, new Uint8Array(20));
      buf.record(3, new Uint8Array(20)); // 60 bytes, within cap=100
      expect(buf.bufferedBytes).toBe(60);

      buf.setCap(40); // must evict down to <= 40 → drops seq=1 then seq=2? 60>40 drop seq1→40, 40>40 false
      // seq=1 (20) evicted → 40 remaining (seq=2,3), 40 is not > 40 so stop.
      expect(buf.bufferedBytes).toBeLessThanOrEqual(40);
      const result = buf.replay(0);
      expect(result.chunks.map((c) => c.seq)).toEqual([2, 3]);
    });

    it("lowering the cap accumulates droppedBytes and marks replay gapped", () => {
      const buf = new TerminalReplayBuffer(100);
      buf.record(1, new Uint8Array(30));
      buf.record(2, new Uint8Array(30));
      expect(buf.droppedBytes).toBe(0);

      buf.setCap(30); // evict seq=1 (30 bytes)
      expect(buf.droppedBytes).toBe(30);
      // Asking for everything (incl. seq=1) now reports a gap.
      const result = buf.replay(0);
      expect(result.gapped).toBe(true);
      expect(result.chunks.map((c) => c.seq)).toEqual([2]);
    });

    it("raising the cap retains more output going forward", () => {
      const buf = new TerminalReplayBuffer(20);
      buf.record(1, new Uint8Array(10));
      buf.record(2, new Uint8Array(10)); // 20, at cap
      buf.setCap(60);
      buf.record(3, new Uint8Array(10));
      buf.record(4, new Uint8Array(10)); // 40 total, all retained under new cap
      const result = buf.replay(0);
      expect(result.gapped).toBe(false);
      expect(result.chunks.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    });

    it("is a no-op for retention when the cap is unchanged", () => {
      const buf = new TerminalReplayBuffer(100);
      buf.record(1, new Uint8Array(30));
      buf.setCap(100);
      expect(buf.droppedBytes).toBe(0);
      expect(buf.replay(0).chunks.length).toBe(1);
    });
  });

  describe("reattach replay within the scrollback budget", () => {
    it("restores a checkpoint followed by only contiguous later output", () => {
      const buf = new TerminalReplayBuffer(1024);
      buf.record(1, new TextEncoder().encode("\u001b[31"));
      buf.record(2, new TextEncoder().encode("mred"));

      expect(buf.checkpointAt(2, "\u001b[31mred")).toBe(true);
      buf.record(3, new TextEncoder().encode(" later"));

      expect(buf.restoreCold()).toMatchObject({
        mode: "checkpoint",
        checkpoint: { seq: 2, data: "\u001b[31mred" },
        chunks: [{ seq: 3 }],
      });
    });

    it("keeps a newer checkpoint when a stale or oversized checkpoint arrives", () => {
      const buf = new TerminalReplayBuffer(16);
      buf.record(3, new Uint8Array([1]));
      expect(buf.checkpointAt(3, "screen")).toBe(true);
      expect(buf.checkpointAt(2, "stale")).toBe(false);
      expect(buf.checkpointAt(3, "x".repeat(17))).toBe(false);
      expect(buf.restoreCold()).toMatchObject({
        mode: "checkpoint",
        checkpoint: { data: "screen" },
      });
    });

    it("rejects a delayed checkpoint when an intermediate delta was evicted", () => {
      const buf = new TerminalReplayBuffer(4);
      buf.record(1, new Uint8Array(4));
      buf.record(2, new Uint8Array(4));
      buf.record(3, new Uint8Array(4));

      expect(buf.checkpointAt(1, "one")).toBe(false);
      expect(buf.restoreCold()).toEqual({
        mode: "reset",
        chunks: [],
        discardThrough: 3,
      });
    });

    it("recomputes the byte total after checkpoint invalidation", () => {
      const buf = new TerminalReplayBuffer(10);
      buf.record(1, new Uint8Array([1]));
      expect(buf.checkpointAt(1, "123456789")).toBe(true);
      buf.record(2, new Uint8Array(1));
      buf.record(3, new Uint8Array(2));

      expect(buf.replay(2).chunks.map((chunk) => chunk.seq)).toEqual([3]);
      expect(buf.bufferedBytes).toBe(2);
    });

    it("returns no retained tail when checkpoint continuity is lost", () => {
      const buf = new TerminalReplayBuffer(12);
      buf.record(1, new Uint8Array([1]));
      expect(buf.checkpointAt(1, "checkpoint")).toBe(true);
      buf.record(2, new Uint8Array(8));

      expect(buf.restoreCold()).toEqual({
        mode: "reset",
        chunks: [],
        discardThrough: 2,
      });
    });

    it("retains roughly the scrollback window and replays its tail", () => {
      // A 200-line scrollback → a byte cap; record well beyond it.
      const cap = replayCapBytesForScrollback(200);
      const buf = new TerminalReplayBuffer(cap);
      const lineBytes = 80; // typical line width
      const totalLines = 5000;
      for (let i = 0; i < totalLines; i++) {
        buf.record(i, new Uint8Array(lineBytes).fill(i & 0xff));
      }
      // Never exceeds its cap.
      expect(buf.bufferedBytes).toBeLessThanOrEqual(cap);
      // A fresh reattach (lastSeq before everything) gets a gap banner because
      // older output was evicted, plus the retained recent tail.
      const result = buf.replay(-1);
      expect(result.gapped).toBe(true);
      expect(result.chunks.length).toBeGreaterThan(0);
      // The most recent line is always retained.
      expect(result.chunks[result.chunks.length - 1]!.seq).toBe(totalLines - 1);
    });

    it("replays without a gap when output stays within the budget", () => {
      const cap = replayCapBytesForScrollback(1000);
      const buf = new TerminalReplayBuffer(cap);
      // 100 lines × 80 bytes = 8 KB, well within the ~500 KB budget.
      for (let i = 0; i < 100; i++) {
        buf.record(i, new Uint8Array(80).fill(i & 0xff));
      }
      const result = buf.replay(-1);
      expect(result.gapped).toBe(false);
      expect(result.chunks.length).toBe(100);
    });
  });
});

describe("replayCapBytesForScrollback", () => {
  it("derives the default 1000-line scrollback from the per-line budget", () => {
    expect(replayCapBytesForScrollback(1000)).toBe(1000 * REPLAY_BYTES_PER_LINE);
  });

  it("treats 0 (unlimited client buffer) as the bounded server maximum", () => {
    expect(replayCapBytesForScrollback(0)).toBe(REPLAY_BUFFER_MAX_CAP_BYTES);
  });

  it("treats negative values as the bounded server maximum", () => {
    expect(replayCapBytesForScrollback(-1)).toBe(REPLAY_BUFFER_MAX_CAP_BYTES);
  });

  it("floors tiny scrollback values at the minimum cap", () => {
    // 10 × 512 = 5120 < 64 KB floor.
    expect(replayCapBytesForScrollback(10)).toBe(REPLAY_BUFFER_MIN_CAP_BYTES);
  });

  it("clamps very large scrollback values at the maximum cap", () => {
    // 5000 (the settings max) × 512 = 2.56 MB, under the 8 MB ceiling.
    expect(replayCapBytesForScrollback(5000)).toBe(5000 * REPLAY_BYTES_PER_LINE);
    // A value beyond what settings allows still saturates at the ceiling.
    expect(replayCapBytesForScrollback(1_000_000)).toBe(REPLAY_BUFFER_MAX_CAP_BYTES);
  });
});
