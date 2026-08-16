/**
 * Legacy circular replay buffer for PTY output.
 *
 * Unlike {@link TerminalFlowControl}, which only buffers during pauses, this
 * buffer retains the most recent PTY output at all times so that reconnecting
 * WebSocket clients can replay what they missed.
 *
 * The buffer is byte-capped: when `bufferedBytes` exceeds `capBytes`, the
 * oldest chunks are evicted from the head until the total is within the cap.
 * A `droppedBytes` counter accumulates evicted bytes so callers can detect
 * whether a replay request covers a gap.
 */

/** Default replay buffer capacity: 512 KB. */
export const REPLAY_BUFFER_DEFAULT_CAP_BYTES = 512 * 1024;

/**
 * Byte budget allotted per scrollback line when converting the
 * `terminal.scrollback` line count into a replay buffer byte cap.
 *
 * Chosen so the default 1000-line scrollback yields ~512 KB, matching the
 * historical fixed cap. Escape-heavy or very wide lines can exceed this, in
 * which case fewer than `scrollback` lines are retained server-side and the
 * replay `gapped` flag (→ reconnect banner) correctly signals the shortfall.
 */
export const REPLAY_BYTES_PER_LINE = 512;

/**
 * Lower bound on the derived cap so even a tiny `terminal.scrollback` still
 * retains enough to cover a WebSocket reconnect replay.
 */
export const REPLAY_BUFFER_MIN_CAP_BYTES = 64 * 1024;

/**
 * Upper bound on the derived cap. Also the cap used when `terminal.scrollback`
 * is 0 ("unlimited"): the client xterm buffer may grow without bound, but
 * server-side retention stays bounded to protect process memory.
 */
export const REPLAY_BUFFER_MAX_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Convert a `terminal.scrollback` line count into a replay buffer byte cap.
 *
 * Uses {@link REPLAY_BYTES_PER_LINE} as the per-line budget, clamped between
 * {@link REPLAY_BUFFER_MIN_CAP_BYTES} and {@link REPLAY_BUFFER_MAX_CAP_BYTES}.
 * A scrollback of 0 means "unlimited" on the client; server retention is
 * capped at the maximum rather than growing without bound.
 *
 * @param scrollbackLines - The `terminal.scrollback` setting (lines).
 * @returns The byte cap to size a {@link TerminalReplayBuffer} with.
 */
export function replayCapBytesForScrollback(scrollbackLines: number): number {
  if (scrollbackLines <= 0) return REPLAY_BUFFER_MAX_CAP_BYTES;
  const raw = scrollbackLines * REPLAY_BYTES_PER_LINE;
  return Math.min(
    REPLAY_BUFFER_MAX_CAP_BYTES,
    Math.max(REPLAY_BUFFER_MIN_CAP_BYTES, raw),
  );
}

/** A single (seq, bytes) entry stored in the replay buffer. */
interface ReplayChunk {
  seq: number;
  bytes: Uint8Array;
}

/** Serialized xterm state captured after the named output sequence. */
export interface TerminalCheckpoint {
  readonly seq: number;
  readonly data: string;
  readonly bytes: number;
}

/** Cold renderer restoration selected by the replay buffer. */
export type ColdRestoreResult =
  | { mode: "checkpoint"; checkpoint: TerminalCheckpoint; chunks: ReadonlyArray<ReplayChunk> }
  | { mode: "replay"; chunks: ReadonlyArray<ReplayChunk> }
  | { mode: "reset"; chunks: readonly []; discardThrough: number };

/**
 * Return value of {@link TerminalReplayBuffer.replay}.
 *
 * `chunks` contains all retained entries with `seq > afterSeq` in arrival
 * order. `gapped` is `true` when the requested sequence position predates the
 * oldest retained entry, meaning the client may have missed output that was
 * already evicted.
 */
export interface ReplayResult {
  chunks: ReadonlyArray<ReplayChunk>;
  gapped: boolean;
}

/**
 * Byte-capped circular replay buffer that retains recent PTY output for
 * WebSocket reconnect replay.
 *
 * Thread safety: not thread-safe — must be used from a single event-loop turn.
 */
export class TerminalReplayBuffer {
  private buffer: Array<ReplayChunk> = [];
  /** Index of the oldest unconsumed entry in `buffer`. */
  private head = 0;
  /** Running total of bytes across all retained chunks. */
  public bufferedBytes = 0;
  /** Running total of bytes dropped via cap eviction. */
  public droppedBytes = 0;
  private capBytes: number;
  private checkpoint: TerminalCheckpoint | null = null;
  private latestSeq = -1;

  /**
   * Creates a new replay buffer.
   *
   * @param capBytes - Maximum bytes to retain. Defaults to
   *   {@link REPLAY_BUFFER_DEFAULT_CAP_BYTES} (512 KB).
   */
  constructor(capBytes: number = REPLAY_BUFFER_DEFAULT_CAP_BYTES) {
    this.capBytes = capBytes;
  }

  /**
   * Length of the backing array (including ghost head slots).
   * Exposed for test assertions about compaction behaviour.
   */
  get bufferLength(): number {
    return this.buffer.length;
  }

  /** Current retention cap in bytes. Exposed for assertions and diagnostics. */
  get cap(): number {
    return this.capBytes;
  }

  /** Highest sequence recorded, including output no longer retained. */
  get latest(): number {
    return this.latestSeq;
  }

  /**
   * Adjust the retention cap at runtime, e.g. when `terminal.scrollback`
   * changes for live sessions.
   *
   * Lowering the cap immediately evicts the oldest chunks down to the new
   * limit (accumulating `droppedBytes`), so a subsequent {@link replay} for a
   * position that fell into the evicted range correctly reports `gapped: true`.
   * Raising the cap retains more going forward; it cannot recover chunks that
   * were already evicted.
   *
   * @param capBytes - New maximum bytes to retain.
   */
  setCap(capBytes: number): void {
    this.capBytes = capBytes;
    this.enforceCap();

    // Compact the backing array if the ghost-head prefix is large, mirroring
    // the threshold used in record().
    if (this.head > 1024 && this.head * 2 >= this.buffer.length) {
      this.buffer = this.buffer.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * Records a new PTY chunk into the buffer.
   *
   * Appends the chunk, then evicts from the head until `bufferedBytes` is
   * within `capBytes`. Uses the same O(1) head-advance technique as
   * {@link TerminalFlowControl} and compacts the backing array when the ghost
   * head prefix grows large enough to matter.
   *
   * @param seq - Monotonic per-PTY sequence number assigned by the caller.
   * @param chunk - Raw bytes emitted by the PTY.
   */
  record(seq: number, chunk: Uint8Array): void {
    this.buffer.push({ seq, bytes: chunk });
    this.bufferedBytes += chunk.length;
    this.latestSeq = Math.max(this.latestSeq, seq);

    this.enforceCap();

    // Compact backing array when the ghost prefix is large enough to matter.
    // Mirrors the compaction threshold in TerminalFlowControl.
    if (this.head > 1024 && this.head * 2 >= this.buffer.length) {
      this.buffer = this.buffer.slice(this.head);
      this.head = 0;
    }
  }

  /**
   * Returns all retained chunks with `seq > afterSeq` along with a gap flag.
   *
   * Callers should pass the last sequence number they received. Passing `0`
   * (or any value before the first recorded seq) returns all retained chunks.
   * Passing `-1` returns everything including seq=0.
   *
   * `gapped` is `true` when bytes were dropped by cap eviction AND the oldest
   * retained chunk's seq is greater than `afterSeq`, meaning the client asked
   * for a position that is no longer in the buffer.
   *
   * @param afterSeq - Return chunks whose `seq` is strictly greater than this.
   */
  replay(afterSeq: number): ReplayResult {
    const active = this.buffer.slice(this.head);

    if (active.length === 0) {
      return { chunks: [], gapped: false };
    }

    const oldestSeq = active[0]!.seq;
    const gapped = this.droppedBytes > 0 && afterSeq < oldestSeq;

    const chunks = active.filter((c) => c.seq > afterSeq);
    return { chunks, gapped };
  }

  /**
   * Stores a bounded xterm serialization when it describes the latest output.
   * Stale, future, and oversized checkpoints are rejected without replacing a
   * usable checkpoint.
   */
  checkpointAt(seq: number, data: string): boolean {
    const bytes = new TextEncoder().encode(data).length;
    const active = this.buffer.slice(this.head);
    const firstLaterSeq = active.find((chunk) => chunk.seq > seq)?.seq;
    const contiguousWithRetainedOutput =
      firstLaterSeq === undefined ? seq === this.latestSeq : firstLaterSeq === seq + 1;
    if (
      seq < (this.checkpoint?.seq ?? -1) ||
      seq > this.latestSeq ||
      bytes > this.capBytes ||
      !contiguousWithRetainedOutput
    ) {
      return false;
    }

    this.checkpoint = { seq, data, bytes };
    while (this.head < this.buffer.length && this.buffer[this.head]!.seq <= seq) {
      const consumed = this.buffer[this.head++]!;
      this.bufferedBytes -= consumed.bytes.length;
    }
    this.enforceCap();
    return this.checkpoint !== null;
  }

  /** Selects a parser-safe cold restore without returning a discontinuous tail. */
  restoreCold(): ColdRestoreResult {
    const active = this.buffer.slice(this.head);
    if (this.checkpoint) {
      return { mode: "checkpoint", checkpoint: this.checkpoint, chunks: active };
    }
    if (this.droppedBytes > 0) {
      return { mode: "reset", chunks: [], discardThrough: this.latestSeq };
    }
    return { mode: "replay", chunks: active };
  }

  /**
   * Clears all buffered chunks and resets all counters.
   *
   * After a clear, {@link replay} returns `gapped: false` — a fresh buffer is
   * not considered a gap.
   */
  clear(): void {
    this.buffer = [];
    this.head = 0;
    this.bufferedBytes = 0;
    this.droppedBytes = 0;
    this.checkpoint = null;
    this.latestSeq = -1;
  }

  private enforceCap(): void {
    while (
      (this.checkpoint?.bytes ?? 0) + this.bufferedBytes > this.capBytes &&
      this.head < this.buffer.length
    ) {
      const evicted = this.buffer[this.head++]!;
      this.bufferedBytes -= evicted.bytes.length;
      this.droppedBytes += evicted.bytes.length;
      if (this.checkpoint && evicted.seq > this.checkpoint.seq) {
        this.checkpoint = null;
      }
    }
    if ((this.checkpoint?.bytes ?? 0) + this.bufferedBytes > this.capBytes) {
      this.checkpoint = null;
    }
  }
}
