import type { TerminalGap, TerminalHydrationDescriptor } from "@mcode/contracts";
import {
  TERMINAL_MAX_CHECKPOINT_BYTES,
  TerminalHydrationDescriptorSchema,
} from "@mcode/contracts";

/** Minimum byte capacity for retained Terminal output. */
export const TERMINAL_MIN_REPLAY_BYTES = 65_536;
/** Maximum byte capacity for retained Terminal output. */
export const TERMINAL_MAX_REPLAY_BYTES = 8_388_608;
/** Estimated replay bytes retained for each configured renderer line. */
export const TERMINAL_REPLAY_BYTES_PER_LINE = 512;

/** One immutable output batch retained for replay. */
export interface TerminalReplayChunk {
  readonly outputSeq: string;
  readonly data: Uint8Array;
}

/** One immutable renderer checkpoint retained by the replay buffer. */
export interface TerminalReplayCheckpoint {
  readonly baseOutputSeq: string;
  readonly data: Uint8Array;
  readonly sha256: string;
}

/** Result of an atomic checkpoint replacement attempt. */
export type TerminalCheckpointInstallResult = "installed" | "stale" | "rejected";

/** Bounded hydration data selected for one attachment. */
export interface TerminalHydration {
  readonly descriptor: TerminalHydrationDescriptor;
  readonly checkpoint: TerminalReplayCheckpoint | null;
  readonly output: ReadonlyArray<TerminalReplayChunk>;
}

interface RetainedChunk {
  readonly outputSeq: bigint;
  readonly data: Uint8Array;
}

interface RetainedCheckpoint {
  readonly baseOutputSeq: bigint;
  readonly data: Uint8Array;
  readonly sha256: string;
}

/** Converts the renderer line limit to the frozen byte replay budget. */
export function replayBytesForScrollback(scrollback: number): number {
  return Math.min(
    TERMINAL_MAX_REPLAY_BYTES,
    Math.max(TERMINAL_MIN_REPLAY_BYTES, scrollback * TERMINAL_REPLAY_BYTES_PER_LINE),
  );
}

/** Byte-bounded output retention and checkpoint selection for one shell session. */
export class TerminalReplayBuffer {
  private readonly chunks: RetainedChunk[] = [];
  private retainedBytes = 0;
  private latestOutputSeq = 0n;
  private checkpoint: RetainedCheckpoint | null = null;

  constructor(private capacityBytes: number) {
    validateCapacity(capacityBytes);
  }

  /** Appends one strictly contiguous host output batch and evicts the oldest bytes. */
  append(outputSeq: bigint, data: Uint8Array): void {
    if (outputSeq !== this.latestOutputSeq + 1n) {
      throw new Error("Terminal replay output is not contiguous");
    }
    if (data.byteLength < 1 || data.byteLength > 65_536) {
      throw new Error("Terminal replay output exceeds the batch bound");
    }
    const retained = Uint8Array.from(data);
    this.chunks.push({ outputSeq, data: retained });
    this.retainedBytes += retained.byteLength;
    this.latestOutputSeq = outputSeq;
    this.evictToCapacity();
    this.invalidateUnusableCheckpoint();
  }

  /** Replaces the checkpoint only when it advances the retained position. */
  installCheckpoint(checkpoint: TerminalReplayCheckpoint): TerminalCheckpointInstallResult {
    const baseOutputSeq = BigInt(checkpoint.baseOutputSeq);
    if (
      checkpoint.data.byteLength < 1 ||
      checkpoint.data.byteLength > TERMINAL_MAX_CHECKPOINT_BYTES ||
      baseOutputSeq > this.latestOutputSeq ||
      (this.chunks.length > 0 && baseOutputSeq + 1n < this.chunks[0]!.outputSeq)
    ) {
      return "rejected";
    }
    if (this.checkpoint !== null && baseOutputSeq <= this.checkpoint.baseOutputSeq) {
      return "stale";
    }
    const tailBytes = this.bytesAfter(baseOutputSeq);
    if (checkpoint.data.byteLength + tailBytes > TERMINAL_MAX_REPLAY_BYTES) {
      return "rejected";
    }
    this.checkpoint = {
      baseOutputSeq,
      data: Uint8Array.from(checkpoint.data),
      sha256: checkpoint.sha256,
    };
    return "installed";
  }

  /** Selects exactly delta, checkpoint plus delta, or reset plus retained tail and gap. */
  hydrate(input: {
    readonly hydrationId: string;
    readonly requestedAfterSeq: bigint;
    readonly checkpointSeq: bigint | null;
  }): TerminalHydration {
    if (input.requestedAfterSeq > this.latestOutputSeq) {
      throw new Error("Terminal hydration requests future output");
    }
    const retainedFromSeq = this.chunks[0]?.outputSeq ?? this.latestOutputSeq;
    const requestedWasEvicted =
      this.chunks.length > 0 && input.requestedAfterSeq + 1n < retainedFromSeq;
    const checkpointRequested = input.checkpointSeq !== null;
    const checkpointMatches =
      checkpointRequested && this.checkpoint?.baseOutputSeq === input.checkpointSeq;

    if (checkpointRequested && !checkpointMatches) {
      return this.resetHydration(input, retainedFromSeq, "stale-checkpoint");
    }
    if (checkpointMatches && this.checkpoint) {
      return this.checkpointHydration(input, this.checkpoint);
    }
    if (requestedWasEvicted) {
      return this.resetHydration(input, retainedFromSeq, "evicted");
    }
    return this.deltaHydration(input);
  }

  /** Applies a new bounded retention limit and evicts the oldest output immediately. */
  resize(capacityBytes: number): void {
    validateCapacity(capacityBytes);
    this.capacityBytes = capacityBytes;
    this.evictToCapacity();
    this.invalidateUnusableCheckpoint();
  }

  private deltaHydration(input: {
    readonly hydrationId: string;
    readonly requestedAfterSeq: bigint;
  }): TerminalHydration {
    const output = this.copyChunksAfter(input.requestedAfterSeq);
    return this.freezeHydration({
      hydrationId: input.hydrationId,
      mode: "delta",
      requestedAfterSeq: input.requestedAfterSeq,
      checkpoint: null,
      output,
      gap: null,
    });
  }

  private checkpointHydration(
    input: { readonly hydrationId: string; readonly requestedAfterSeq: bigint },
    checkpoint: RetainedCheckpoint,
  ): TerminalHydration {
    const output = this.copyChunksAfter(checkpoint.baseOutputSeq);
    return this.freezeHydration({
      hydrationId: input.hydrationId,
      mode: "checkpoint-delta",
      requestedAfterSeq: input.requestedAfterSeq,
      checkpoint: copyCheckpoint(checkpoint),
      output,
      gap: null,
    });
  }

  private resetHydration(
    input: { readonly hydrationId: string; readonly requestedAfterSeq: bigint },
    retainedFromSeq: bigint,
    reason: TerminalGap["reason"],
  ): TerminalHydration {
    const output = this.copyChunksAfter(retainedFromSeq - 1n);
    const firstMissingSeq = input.requestedAfterSeq + 1n < retainedFromSeq
      ? input.requestedAfterSeq + 1n
      : 0n;
    const lastMissingSeq = retainedFromSeq > 0n ? retainedFromSeq - 1n : 0n;
    const gap: TerminalGap = Object.freeze({
      kind: "replay",
      firstMissingSeq: firstMissingSeq.toString(),
      lastMissingSeq: lastMissingSeq.toString(),
      retainedFromSeq: retainedFromSeq.toString(),
      retainedThroughSeq: this.latestOutputSeq.toString(),
      reason,
    });
    return this.freezeHydration({
      hydrationId: input.hydrationId,
      mode: "reset-tail-gap",
      requestedAfterSeq: input.requestedAfterSeq,
      checkpoint: null,
      output,
      gap,
    });
  }

  private freezeHydration(input: {
    readonly hydrationId: string;
    readonly mode: TerminalHydrationDescriptor["mode"];
    readonly requestedAfterSeq: bigint;
    readonly checkpoint: TerminalReplayCheckpoint | null;
    readonly output: ReadonlyArray<TerminalReplayChunk>;
    readonly gap: TerminalGap | null;
  }): TerminalHydration {
    const totalBytes =
      (input.checkpoint?.data.byteLength ?? 0) +
      input.output.reduce((total, chunk) => total + chunk.data.byteLength, 0);
    const outputBytes = input.output.reduce(
      (total, chunk) => total + chunk.data.byteLength,
      0,
    );
    const chunkCount =
      Math.ceil((input.checkpoint?.data.byteLength ?? 0) / 65_536) +
      Math.ceil(outputBytes / 65_536);
    const descriptor = TerminalHydrationDescriptorSchema().parse({
      hydrationId: input.hydrationId,
      mode: input.mode,
      requestedAfterSeq: input.requestedAfterSeq.toString(),
      checkpointThroughSeq: input.checkpoint?.baseOutputSeq ?? null,
      firstOutputSeq: input.output[0]?.outputSeq ?? null,
      lastOutputSeq: input.output.at(-1)?.outputSeq ?? null,
      gap: input.gap,
      chunkCount,
      totalBytes,
    });
    return Object.freeze({
      descriptor: Object.freeze(descriptor),
      checkpoint: input.checkpoint,
      output: Object.freeze([...input.output]),
    });
  }

  private copyChunksAfter(outputSeq: bigint): ReadonlyArray<TerminalReplayChunk> {
    return Object.freeze(
      this.chunks
        .filter((chunk) => chunk.outputSeq > outputSeq)
        .map((chunk) => Object.freeze({
          outputSeq: chunk.outputSeq.toString(),
          data: Uint8Array.from(chunk.data),
        })),
    );
  }

  private bytesAfter(outputSeq: bigint): number {
    return this.chunks.reduce(
      (total, chunk) => total + (chunk.outputSeq > outputSeq ? chunk.data.byteLength : 0),
      0,
    );
  }

  private evictToCapacity(): void {
    while (this.retainedBytes > this.capacityBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift();
      if (removed) this.retainedBytes -= removed.data.byteLength;
    }
  }

  private invalidateUnusableCheckpoint(): void {
    if (
      this.checkpoint &&
      ((this.chunks.length > 0 &&
        this.checkpoint.baseOutputSeq + 1n < this.chunks[0]!.outputSeq) ||
        this.checkpoint.data.byteLength + this.bytesAfter(this.checkpoint.baseOutputSeq) >
          TERMINAL_MAX_REPLAY_BYTES)
    ) {
      this.checkpoint = null;
    }
  }
}

function copyCheckpoint(checkpoint: RetainedCheckpoint): TerminalReplayCheckpoint {
  return Object.freeze({
    baseOutputSeq: checkpoint.baseOutputSeq.toString(),
    data: Uint8Array.from(checkpoint.data),
    sha256: checkpoint.sha256,
  });
}

function validateCapacity(capacityBytes: number): void {
  if (
    !Number.isInteger(capacityBytes) ||
    capacityBytes < TERMINAL_MIN_REPLAY_BYTES ||
    capacityBytes > TERMINAL_MAX_REPLAY_BYTES
  ) {
    throw new Error("Terminal replay capacity is outside the frozen bounds");
  }
}
