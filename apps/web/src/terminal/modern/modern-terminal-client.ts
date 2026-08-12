import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  decodeTerminalFrame,
  TerminalHydrationDescriptorSchema,
  encodeTerminalFrame,
  type TerminalBackendCapabilities,
  type TerminalScope,
  type TerminalSessionSnapshot,
} from "@mcode/contracts";
import { emitPtyData, emitPtyExit, emitPtyReconnectGap } from "../legacy/pty-data-registry";
import type { TerminalClient, TerminalClientReattachResult, TerminalRpcCall } from "../terminal-client";

interface ClientAttachment {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly hostGeneration: string;
  attachmentEpoch: string;
  hydrationId: string;
  commandSeq: bigint;
  lastOutputSeq: bigint;
  readonly hydrationChunks: Map<number, Uint8Array>;
  readonly pendingOutput: Array<{ readonly seq: string; readonly data: Uint8Array }>;
  hydrationChunkCount: number | null;
  hydrationOutputCount: number;
  hydrated: boolean;
  hydrationDescriptor: {
    readonly mode: "delta" | "checkpoint-delta" | "reset-tail-gap";
    readonly checkpointThroughSeq: string | null;
    readonly lastOutputSeq: string | null;
  } | null;
  hydrationPayload: Uint8Array | null;
}

/** Sends one encoded Terminal v1 binary frame to the server. */
export type TerminalBinarySend = (frame: Uint8Array) => void;
/** Resolves a UI scope ID to the server-owned Terminal scope. */
export type TerminalScopeResolver = (scopeId: string) => Promise<TerminalScope>;

/** Adapts the current Terminal UI seam to strict v1 management and binary transport. */
export class ModernTerminalClient implements TerminalClient {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly attachments = new Map<string, ClientAttachment>();
  private readonly checkpointThroughSeq = new Map<string, string>();

  constructor(
    private readonly rpc: TerminalRpcCall,
    private readonly sendFrame: TerminalBinarySend,
    private readonly capabilities: Extract<TerminalBackendCapabilities, { contractVersion: 1 }>,
    private readonly resolveScope: TerminalScopeResolver,
  ) {}

  /** Creates one modern session for the current thread or workspace scope. */
  async create(scopeId: string): Promise<{ ptyId: string; shell: string }> {
    const scope = await this.resolveScope(scopeId);
    const session = await this.rpc<TerminalSessionSnapshot>("terminal.session.create", { scope });
    this.sessions.set(session.sessionId, session);
    return { ptyId: session.sessionId, shell: session.launch.resolvedProfile.executable };
  }

  /** Sends ordered UTF-8 input through the active v1 attachment. */
  async write(ptyId: string, data: string): Promise<void> {
    const attachment = this.requireAttachment(ptyId);
    attachment.commandSeq += 1n;
    this.send(attachment, "input", attachment.commandSeq, new TextEncoder().encode(data));
  }

  /** Sends an ordered latest-wins resize through the active v1 attachment. */
  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    const attachment = this.requireAttachment(ptyId);
    attachment.commandSeq += 1n;
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, cols, false);
    view.setUint16(2, rows, false);
    this.send(attachment, "resize", attachment.commandSeq, payload);
  }

  /** Closes one modern session. */
  async kill(ptyId: string): Promise<void> {
    await this.rpc("terminal.session.close", { sessionId: ptyId, reason: "user" });
    this.sessions.delete(ptyId);
    this.attachments.delete(ptyId);
    this.checkpointThroughSeq.delete(ptyId);
  }

  /** Releases the current controller lease while the Terminal is hidden. */
  async pause(ptyId: string): Promise<void> {
    const attachment = this.attachments.get(ptyId);
    if (!attachment) return;
    await this.rpc("terminal.session.detach", {
      sessionId: ptyId,
      attachmentId: attachment.attachmentId,
      attachmentEpoch: attachment.attachmentEpoch,
      reason: "hide",
    });
    this.attachments.delete(ptyId);
  }

  /** Reattachment owns resume for v1, so this operation is intentionally empty. */
  async resume(): Promise<void> {}

  /** Closes all sessions in the requested UI scope. */
  async killByThread(scopeId: string): Promise<void> {
    const scope = await this.resolveScope(scopeId);
    const sessions = await this.rpc<TerminalSessionSnapshot[]>("terminal.session.list", { scope });
    await Promise.all(sessions.map((session) => this.kill(session.sessionId)));
  }

  /** Acquires a new controller epoch and consumes hidden hydration frames. */
  async reattach(ptyId: string, lastSeq: number): Promise<TerminalClientReattachResult> {
    const session = this.sessions.get(ptyId);
    const attachment: ClientAttachment = {
      sessionId: ptyId,
      attachmentId: crypto.randomUUID(),
      hostGeneration: session?.hostGeneration ?? this.capabilities.host.generation,
      attachmentEpoch: "0",
      hydrationId: crypto.randomUUID(),
      commandSeq: BigInt(session?.lastCommandSeq ?? "0"),
      lastOutputSeq: BigInt(Math.max(0, lastSeq)),
      hydrationChunks: new Map(),
      pendingOutput: [],
      hydrationChunkCount: null,
      hydrationOutputCount: 0,
      hydrated: false,
      hydrationDescriptor: null,
      hydrationPayload: null,
    };
    this.attachments.set(ptyId, attachment);
    let descriptor: { attachmentEpoch: string; hydrationId: string };
    try {
      descriptor = await this.rpc<{
        attachmentEpoch: string;
        hydrationId: string;
      }>("terminal.session.attach", {
        sessionId: ptyId,
        attachmentId: attachment.attachmentId,
        hostGeneration: attachment.hostGeneration,
        lastOutputSeq: attachment.lastOutputSeq.toString(),
        lastCommandSeq: attachment.commandSeq.toString(),
        ...(this.checkpointThroughSeq.has(ptyId)
          ? { checkpointSeq: this.checkpointThroughSeq.get(ptyId) }
          : {}),
      });
    } catch (error) {
      this.checkpointThroughSeq.delete(ptyId);
      this.attachments.delete(ptyId);
      throw error;
    }
    attachment.attachmentEpoch = descriptor.attachmentEpoch;
    attachment.hydrationId = descriptor.hydrationId;
    const hydration = attachment.hydrationDescriptor;
    if (!hydration) return { mode: "delta" };
    if (hydration.mode === "checkpoint-delta") {
      return {
        mode: "checkpoint",
        checkpoint: new TextDecoder().decode(attachment.hydrationPayload ?? new Uint8Array()),
        checkpointThrough: Number(hydration.checkpointThroughSeq ?? "0"),
      };
    }
    if (hydration.mode === "reset-tail-gap") {
      this.checkpointThroughSeq.delete(ptyId);
      return { mode: "reset", discardThrough: Number(hydration.lastOutputSeq ?? "0") };
    }
    return { mode: "delta" };
  }

  /** Uploads one bounded renderer checkpoint through the v1 authority. */
  async checkpoint(ptyId: string, seq: number, value: string): Promise<{ accepted: boolean }> {
    const attachment = this.requireAttachment(ptyId);
    const data = new TextEncoder().encode(value);
    if (data.byteLength === 0) return { accepted: false };
    const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
    const begun = await this.rpc<{ uploadId: string }>("terminal.session.checkpoint.begin", {
      sessionId: ptyId,
      attachmentId: attachment.attachmentId,
      attachmentEpoch: attachment.attachmentEpoch,
      hostGeneration: attachment.hostGeneration,
      baseOutputSeq: String(Math.max(0, seq)),
      declaredBytes: data.byteLength,
      sha256,
    });
    const chunkCount = Math.ceil(data.byteLength / TERMINAL_CHECKPOINT_CHUNK_BYTES);
    for (let index = 0; index < chunkCount; index += 1) {
      this.send(attachment, "checkpointChunk", BigInt(index), data.slice(index * TERMINAL_CHECKPOINT_CHUNK_BYTES, (index + 1) * TERMINAL_CHECKPOINT_CHUNK_BYTES), {
        relatedSeq: String(chunkCount), uploadId: begun.uploadId,
      });
    }
    const completed = await this.rpc<{ accepted: true; checkpointThroughSeq: string }>("terminal.session.checkpoint.complete", {
      sessionId: ptyId,
      attachmentId: attachment.attachmentId,
      attachmentEpoch: attachment.attachmentEpoch,
      hostGeneration: attachment.hostGeneration,
      uploadId: begun.uploadId,
      totalBytes: data.byteLength,
      sha256,
    });
    if (completed.accepted) this.checkpointThroughSeq.set(ptyId, completed.checkpointThroughSeq);
    return completed;
  }

  /** Lists server-authoritative sessions through the current UI shape. */
  async listActive(): Promise<Array<{ ptyId: string; threadId: string }>> {
    const sessions = await this.rpc<TerminalSessionSnapshot[]>("terminal.session.list", {});
    for (const session of sessions) this.sessions.set(session.sessionId, session);
    return sessions
      .filter((session) => session.state === "running" || session.state === "starting")
      .map((session) => ({
        ptyId: session.sessionId,
        threadId: session.scope.kind === "thread" ? session.scope.threadId : session.scope.workspaceId,
      }));
  }

  /** Reports whether one modern session owns child processes. */
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return this.rpc("terminal.session.hasChildren", { sessionId: ptyId });
  }

  /** Applies a server v1 frame to the exact attachment and existing PTY registry. */
  handleFrame(bytes: Uint8Array): void {
    const frame = decodeTerminalFrame(bytes);
    const attachment = this.attachments.get(frame.sessionId);
    if (!attachment || attachment.attachmentId !== frame.attachmentId) return;
    if (attachment.hostGeneration !== frame.hostGeneration) return;
    if (frame.kind === "hydrationChunk") {
      if (frame.hydrationId !== attachment.hydrationId && attachment.attachmentEpoch !== "0") {
        throw new Error("Terminal hydration belongs to a stale attachment");
      }
      const index = Number(frame.primarySeq);
      const count = Number(frame.relatedSeq);
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || attachment.hydrationChunks.has(index)) {
        throw new Error("Terminal hydration chunk sequence is invalid");
      }
      if (attachment.hydrationChunkCount !== null && attachment.hydrationChunkCount !== count) {
        throw new Error("Terminal hydration chunk count changed");
      }
      attachment.hydrationChunkCount = count;
      attachment.attachmentEpoch = frame.attachmentEpoch;
      attachment.hydrationId = frame.hydrationId!;
      attachment.hydrationChunks.set(index, Uint8Array.from(frame.payload));
      return;
    }
    if (frame.kind === "hydrationComplete") {
      const descriptor = TerminalHydrationDescriptorSchema().parse(
        JSON.parse(new TextDecoder().decode(frame.payload)),
      );
      if (attachment.attachmentEpoch !== "0" && frame.hydrationId !== attachment.hydrationId) {
        throw new Error("Terminal hydration belongs to a stale attachment");
      }
      attachment.hydrationId = frame.hydrationId!;
      const declaredChunks = attachment.hydrationChunkCount ?? 0;
      if (
        !Number.isInteger(declaredChunks) ||
        declaredChunks < 0 ||
        attachment.hydrationChunks.size + attachment.hydrationOutputCount !== descriptor.chunkCount
      ) {
        throw new Error("Terminal hydration is incomplete");
      }
      for (let index = 0; index < declaredChunks; index += 1) {
        if (!attachment.hydrationChunks.has(index)) throw new Error("Terminal hydration chunks are not contiguous");
      }
      attachment.attachmentEpoch = frame.attachmentEpoch;
      attachment.hydrated = true;
      const payload = concatBytes([...attachment.hydrationChunks.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk));
      attachment.hydrationChunks.clear();
      attachment.hydrationDescriptor = descriptor;
      attachment.hydrationPayload = descriptor.mode === "checkpoint-delta" ? payload : null;
      const outputSeq = descriptor.lastOutputSeq ?? attachment.lastOutputSeq.toString();
      attachment.lastOutputSeq = BigInt(outputSeq);
      if (payload.byteLength > 0 && descriptor.mode !== "checkpoint-delta") {
        emitPtyData({ ptyId: frame.sessionId, payload, seq: Number(outputSeq) });
      }
      if (descriptor.gap) emitPtyReconnectGap({ ptyId: frame.sessionId });
      for (const output of attachment.pendingOutput.splice(0)) {
        attachment.lastOutputSeq = BigInt(output.seq);
        emitPtyData({ ptyId: frame.sessionId, payload: output.data, seq: Number(output.seq) });
      }
      return;
    }
    if (frame.kind === "output") {
      if (!attachment.hydrated) {
        if (attachment.attachmentEpoch !== "0" && frame.hydrationId !== attachment.hydrationId) {
          throw new Error("Terminal output belongs to a stale hydration");
        }
        attachment.attachmentEpoch = frame.attachmentEpoch;
        attachment.hydrationId = frame.hydrationId!;
        attachment.hydrationOutputCount += 1;
        attachment.pendingOutput.push({ seq: frame.primarySeq, data: Uint8Array.from(frame.payload) });
        return;
      }
      attachment.lastOutputSeq = BigInt(frame.primarySeq);
      emitPtyData({ ptyId: frame.sessionId, payload: frame.payload, seq: Number(frame.primarySeq) });
      return;
    }
    if (frame.kind === "gap") {
      emitPtyReconnectGap({ ptyId: frame.sessionId });
      return;
    }
    if (frame.kind === "exitBarrier") {
      const value = JSON.parse(new TextDecoder().decode(frame.payload)) as { exit: { code: number | null } };
      emitPtyExit({ ptyId: frame.sessionId, code: value.exit.code ?? 0 });
    }
  }

  /** Acknowledges output only after the renderer records it as written. */
  acknowledgeOutput(ptyId: string, seq: number): void {
    const attachment = this.attachments.get(ptyId);
    if (!attachment) return;
    attachment.lastOutputSeq = BigInt(Math.max(0, seq));
    this.acknowledge(attachment);
  }

  private acknowledge(attachment: ClientAttachment): void {
    this.send(attachment, "outputAck", attachment.lastOutputSeq, new Uint8Array());
  }

  private requireAttachment(ptyId: string): ClientAttachment {
    const attachment = this.attachments.get(ptyId);
    if (!attachment || attachment.attachmentEpoch === "0") throw new Error("Terminal session is not attached");
    return attachment;
  }

  private send(
    attachment: ClientAttachment,
    kind: "input" | "resize" | "outputAck" | "checkpointChunk",
    primarySeq: bigint,
    payload: Uint8Array,
    options: { relatedSeq?: string; uploadId?: string } = {},
  ): void {
    this.sendFrame(encodeTerminalFrame({
      kind,
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
      hostGeneration: attachment.hostGeneration,
      attachmentEpoch: attachment.attachmentEpoch,
      primarySeq: primarySeq.toString(),
      relatedSeq: options.relatedSeq ?? "0",
      ...(options.uploadId ? { uploadId: options.uploadId } : {}),
      payload,
    }));
  }
}

function concatBytes(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
