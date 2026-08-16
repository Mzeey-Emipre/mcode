import { describe, expect, it } from "vitest";
import {
  replayBytesForScrollback,
  TerminalReplayBuffer,
  TERMINAL_MAX_REPLAY_BYTES,
  TERMINAL_MIN_REPLAY_BYTES,
} from "../terminal-replay-buffer.js";

const HYDRATION_ID = "00000000-0000-4000-8000-000000000001";

function text(chunk: Uint8Array): string {
  return Buffer.from(chunk).toString();
}

describe("TerminalReplayBuffer", () => {
  it("returns only the contiguous delta after the renderer position", () => {
    const replay = new TerminalReplayBuffer(TERMINAL_MIN_REPLAY_BYTES);
    replay.append(1n, Buffer.from("one"));
    replay.append(2n, Buffer.from("two"));

    const hydration = replay.hydrate({
      hydrationId: HYDRATION_ID,
      requestedAfterSeq: 1n,
      checkpointSeq: null,
    });

    expect(hydration.descriptor).toEqual({
      hydrationId: HYDRATION_ID,
      mode: "delta",
      requestedAfterSeq: "1",
      checkpointThroughSeq: null,
      firstOutputSeq: "2",
      lastOutputSeq: "2",
      gap: null,
      chunkCount: 1,
      totalBytes: 3,
    });
    expect(hydration.output.map((chunk) => text(chunk.data))).toEqual(["two"]);
  });

  it("returns a matching checkpoint followed by its contiguous delta", () => {
    const replay = new TerminalReplayBuffer(TERMINAL_MIN_REPLAY_BYTES);
    replay.append(1n, Buffer.from("one"));
    expect(replay.installCheckpoint({
      baseOutputSeq: "1",
      data: Buffer.from("screen"),
      sha256: "a".repeat(64),
    })).toBe("installed");
    replay.append(2n, Buffer.from("two"));

    const hydration = replay.hydrate({
      hydrationId: HYDRATION_ID,
      requestedAfterSeq: 0n,
      checkpointSeq: 1n,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "checkpoint-delta",
      checkpointThroughSeq: "1",
      firstOutputSeq: "2",
      lastOutputSeq: "2",
      gap: null,
      chunkCount: 2,
      totalBytes: 9,
    });
    expect(text(hydration.checkpoint?.data ?? new Uint8Array())).toBe("screen");
    expect(hydration.output.map((chunk) => text(chunk.data))).toEqual(["two"]);
  });

  it("returns a reset, retained tail, and explicit gap after eviction", () => {
    const replay = new TerminalReplayBuffer(TERMINAL_MIN_REPLAY_BYTES);
    replay.append(1n, new Uint8Array(40_000).fill(1));
    replay.append(2n, new Uint8Array(40_000).fill(2));

    const hydration = replay.hydrate({
      hydrationId: HYDRATION_ID,
      requestedAfterSeq: 0n,
      checkpointSeq: null,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "reset-tail-gap",
      requestedAfterSeq: "0",
      firstOutputSeq: "2",
      lastOutputSeq: "2",
      gap: {
        kind: "replay",
        firstMissingSeq: "1",
        lastMissingSeq: "1",
        retainedFromSeq: "2",
        retainedThroughSeq: "2",
        reason: "evicted",
      },
      chunkCount: 1,
      totalBytes: 40_000,
    });
    expect(hydration.output).toHaveLength(1);
    expect(hydration.output[0]?.data[0]).toBe(2);
  });

  it("does not use a stale checkpoint as reconstruction authority", () => {
    const replay = new TerminalReplayBuffer(TERMINAL_MIN_REPLAY_BYTES);
    replay.append(1n, Buffer.from("one"));

    const hydration = replay.hydrate({
      hydrationId: HYDRATION_ID,
      requestedAfterSeq: 1n,
      checkpointSeq: 1n,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "reset-tail-gap",
      gap: { reason: "stale-checkpoint" },
    });
    expect(hydration.checkpoint).toBeNull();
  });

  it("invalidates a checkpoint when eviction breaks its following delta", () => {
    const replay = new TerminalReplayBuffer(TERMINAL_MIN_REPLAY_BYTES);
    replay.append(1n, Buffer.from("one"));
    expect(replay.installCheckpoint({
      baseOutputSeq: "1",
      data: Buffer.from("screen"),
      sha256: "a".repeat(64),
    })).toBe("installed");
    replay.append(2n, new Uint8Array(40_000).fill(2));
    replay.append(3n, new Uint8Array(40_000).fill(3));

    const hydration = replay.hydrate({
      hydrationId: HYDRATION_ID,
      requestedAfterSeq: 0n,
      checkpointSeq: 1n,
    });

    expect(hydration.descriptor).toMatchObject({
      mode: "reset-tail-gap",
      firstOutputSeq: "3",
      gap: { reason: "stale-checkpoint", retainedFromSeq: "3" },
    });
  });

  it("applies the frozen replay bounds and rejects non-contiguous host output", () => {
    expect(replayBytesForScrollback(10)).toBe(TERMINAL_MIN_REPLAY_BYTES);
    expect(replayBytesForScrollback(1_000)).toBe(512_000);
    expect(replayBytesForScrollback(1_000_000)).toBe(TERMINAL_MAX_REPLAY_BYTES);

    const replay = new TerminalReplayBuffer(TERMINAL_MIN_REPLAY_BYTES);
    expect(() => replay.append(2n, Buffer.from("gap"))).toThrow(
      "Terminal replay output is not contiguous",
    );
    expect(() => replay.resize(TERMINAL_MIN_REPLAY_BYTES - 1)).toThrow(
      "Terminal replay capacity is outside the frozen bounds",
    );
  });
});
