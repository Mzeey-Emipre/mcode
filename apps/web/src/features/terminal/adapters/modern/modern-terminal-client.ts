import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  decodeTerminalFrame,
  TerminalExitMetadataSchema,
  TerminalGapSchema,
  TerminalHydrationDescriptorSchema,
  encodeTerminalFrame,
  type TerminalBinaryFrame,
  type TerminalBackendCapabilities,
  type TerminalGap,
  type TerminalHydrationDescriptor,
  type TerminalScope,
  type TerminalSessionSnapshot,
  TerminalDiagnosticsBundleSchema,
} from "@mcode/contracts";
import { withTerminalTimeout } from "../terminal-client";
import type {
  TerminalClient,
  TerminalCheckpoint,
  TerminalClientReattachResult,
  TerminalClientSubscription,
  TerminalActiveSession,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalRpcCall,
} from "../terminal-client";

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
  hydrationDescriptor: TerminalHydrationDescriptor | null;
  hydrationPayload: Uint8Array | null;
}

type HydrationDescriptor = TerminalHydrationDescriptor;

/** Sends one encoded Terminal v1 binary frame to the server. */
export type TerminalBinarySend = (frame: Uint8Array) => void;
/** Resolves a UI scope ID to the server-owned Terminal scope. */
export type TerminalScopeResolver = (scopeId: string) => Promise<TerminalScope>;

/** Adapts the current Terminal UI seam to strict v1 management and binary transport. */
export class ModernTerminalClient implements TerminalClient {
  private readonly sessions = new Map<string, TerminalSessionSnapshot>();
  private readonly attachments = new Map<string, ClientAttachment>();
  private readonly checkpointThroughSeq = new Map<string, string>();
  private readonly subscriptions = new Map<string, Set<TerminalClientSubscription>>();

  constructor(
    private readonly rpc: TerminalRpcCall,
    private readonly sendFrame: TerminalBinarySend,
    private readonly capabilities: Extract<TerminalBackendCapabilities, { contractVersion: 1 }>,
    private readonly resolveScope: TerminalScopeResolver,
  ) {}

  /** Creates one modern session for the current thread or workspace scope. */
  async create(scopeId: string, replacesSessionId?: string): Promise<{ ptyId: string; shell: string }> {
    const scope = await this.resolveScope(scopeId);
    const session = await this.rpc<TerminalSessionSnapshot>("terminal.session.create", {
      scope,
      ...(replacesSessionId ? { replacesSessionId } : {}),
    });
    if (replacesSessionId) this.sessions.delete(replacesSessionId);
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

  /** Keeps the server attachment alive while the renderer changes visibility. */
  async pause(ptyId: string): Promise<void> {
    void ptyId;
  }

  /** Reattachment owns resume for v1, so this operation is intentionally empty. */
  async resume(): Promise<void> {}

  /** Detaches the renderer lease when switching to another shell. */
  detachForSwitch(
    ptyId: string,
    checkpoint?: Promise<TerminalCheckpoint | undefined>,
  ): Promise<void> {
    const attachment = this.attachments.get(ptyId);
    if (!attachment) return Promise.resolve();
    const checkpointState = checkpoint
      ? withTerminalTimeout(checkpoint).catch(() => undefined)
      : Promise.resolve(undefined);
    const operation = checkpointState
      .then((state) => state
        ? withTerminalTimeout(this.checkpointAttachment(attachment, state.seq, state.data)).catch(() => undefined)
        : undefined)
      .then(() => withTerminalTimeout(this.rpc<void>("terminal.session.detach", {
        sessionId: ptyId,
        attachmentId: attachment.attachmentId,
        attachmentEpoch: attachment.attachmentEpoch,
        reason: "switch",
      })))
      .finally(() => {
        if (this.attachments.get(ptyId) === attachment) this.attachments.delete(ptyId);
      });
    return operation;
  }

  /** Subscribes a renderer controller to this client's attachment delivery. */
  subscribe(ptyId: string, subscription: TerminalClientSubscription): () => void {
    const subscriptions = this.subscriptions.get(ptyId) ?? new Set<TerminalClientSubscription>();
    subscriptions.add(subscription);
    this.subscriptions.set(ptyId, subscriptions);
    return () => {
      subscriptions.delete(subscription);
      if (subscriptions.size === 0) this.subscriptions.delete(ptyId);
    };
  }

  /** Delivers a reconnect gap to the subscriptions for one modern session. */
  notifyReconnectGap(ptyId: string): void {
    this.emitReconnectGap(ptyId);
  }

  /** Closes all sessions in the requested UI scope. */
  async killByThread(scopeId: string): Promise<void> {
    const scope = await this.resolveScope(scopeId);
    const sessions = await this.rpc<TerminalSessionSnapshot[]>("terminal.session.list", { scope });
    await Promise.all(sessions.map((session) => this.kill(session.sessionId)));
  }

  /** Acquires a new controller epoch and consumes hidden hydration frames. */
  async reattach(ptyId: string, lastSeq: number): Promise<TerminalClientReattachResult> {
    const attachment = this.createAttachment(ptyId, lastSeq);
    this.attachments.set(ptyId, attachment);
    try {
      this.applyAttachmentDescriptor(attachment, await this.attachSession(attachment));
    } catch (error) {
      this.discardAttachment(ptyId, attachment);
      throw error;
    }
    return this.reattachResult(ptyId, attachment);
  }

  /** Uploads one bounded renderer checkpoint through the v1 authority. */
  async checkpoint(ptyId: string, seq: number, value: string): Promise<{ accepted: boolean }> {
    return withTerminalTimeout(this.checkpointAttachment(this.requireAttachment(ptyId), seq, value));
  }

  private async checkpointAttachment(
    attachment: ClientAttachment,
    seq: number,
    value: string,
  ): Promise<{ accepted: boolean }> {
    const data = new TextEncoder().encode(value);
    if (data.byteLength === 0) return { accepted: false };
    const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
    const begun = await this.rpc<{ uploadId: string }>("terminal.session.checkpoint.begin", {
      sessionId: attachment.sessionId,
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
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
      attachmentEpoch: attachment.attachmentEpoch,
      hostGeneration: attachment.hostGeneration,
      uploadId: begun.uploadId,
      totalBytes: data.byteLength,
      sha256,
    });
    if (completed.accepted) this.checkpointThroughSeq.set(attachment.sessionId, completed.checkpointThroughSeq);
    return completed;
  }

  /** Lists server-authoritative sessions through the current UI shape. */
  async listActive(): Promise<TerminalActiveSession[]> {
    const sessions = await this.rpc<TerminalSessionSnapshot[]>("terminal.session.list", {});
    for (const session of sessions) this.sessions.set(session.sessionId, session);
    return sessions.map((session) => ({
        ptyId: session.sessionId,
        threadId: session.scope.kind === "thread" ? session.scope.threadId : session.scope.workspaceId,
        state: session.state,
        ...(session.exit ? { exit: session.exit } : {}),
      }));
  }

  /** Reports whether one modern session owns child processes. */
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return this.rpc("terminal.session.hasChildren", { sessionId: ptyId });
  }

  /** Fetches and validates the content-free diagnostics bundle at the v1 boundary. */
  async diagnostics(): Promise<import("@mcode/contracts").TerminalDiagnosticsBundle> {
    return TerminalDiagnosticsBundleSchema().parse(
      await this.rpc("terminal.diagnostics.getBundle", {}),
    );
  }

  /** Applies a server v1 frame to the exact client-owned attachment. */
  handleFrame(bytes: Uint8Array): void {
    const frame = decodeTerminalFrame(bytes);
    const attachment = this.attachmentForFrame(frame);
    if (!attachment) return;
    switch (frame.kind) {
      case "hydrationChunk":
        this.handleHydrationChunk(attachment, frame);
        return;
      case "hydrationComplete":
        this.handleHydrationComplete(attachment, frame);
        return;
      case "output":
        this.handleOutput(attachment, frame);
        return;
      case "gap":
        this.handleGap(frame);
        return;
      case "exitBarrier":
        this.handleExitBarrier(frame);
        return;
      case "commandAck":
      case "state":
        return;
    }
  }

  private attachmentForFrame(frame: TerminalBinaryFrame): ClientAttachment | null {
    const attachment = this.attachments.get(frame.sessionId);
    if (!attachment || attachment.attachmentId !== frame.attachmentId) return null;
    return this.acceptFrameIdentity(attachment, frame) ? attachment : null;
  }

  private createAttachment(ptyId: string, lastSeq: number): ClientAttachment {
    const session = this.sessions.get(ptyId);
    return {
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
  }

  private attachSession(attachment: ClientAttachment): Promise<{ attachmentEpoch: string; hydrationId: string }> {
    return this.rpc("terminal.session.attach", {
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
      hostGeneration: attachment.hostGeneration,
      lastOutputSeq: attachment.lastOutputSeq.toString(),
      lastCommandSeq: attachment.commandSeq.toString(),
      ...(this.checkpointThroughSeq.has(attachment.sessionId)
        ? { checkpointSeq: this.checkpointThroughSeq.get(attachment.sessionId) }
        : {}),
    });
  }

  private applyAttachmentDescriptor(
    attachment: ClientAttachment,
    descriptor: { attachmentEpoch: string; hydrationId: string },
  ): void {
    attachment.attachmentEpoch = descriptor.attachmentEpoch;
    attachment.hydrationId = descriptor.hydrationId;
  }

  private discardAttachment(ptyId: string, attachment: ClientAttachment): void {
    this.checkpointThroughSeq.delete(ptyId);
    if (this.attachments.get(ptyId) === attachment) this.attachments.delete(ptyId);
  }

  private reattachResult(ptyId: string, attachment: ClientAttachment): TerminalClientReattachResult {
    const hydration = attachment.hydrationDescriptor;
    if (!hydration || hydration.mode === "delta") return { mode: "delta" };
    if (hydration.mode === "reset-tail-gap") {
      this.checkpointThroughSeq.delete(ptyId);
      return { mode: "reset", discardThrough: Number(hydration.lastOutputSeq ?? "0") };
    }
    return {
      mode: "checkpoint",
      checkpoint: new TextDecoder().decode(attachment.hydrationPayload ?? new Uint8Array()),
      checkpointThrough: Number(hydration.checkpointThroughSeq ?? "0"),
    };
  }

  private handleHydrationChunk(attachment: ClientAttachment, frame: TerminalBinaryFrame): void {
    const index = Number(frame.primarySeq);
    const count = Number(frame.relatedSeq);
    if (!isValidHydrationChunk(attachment, index, count)) {
      throw new Error("Terminal hydration chunk sequence is invalid");
    }
    if (attachment.hydrationChunkCount !== null && attachment.hydrationChunkCount !== count) {
      throw new Error("Terminal hydration chunk count changed");
    }
    attachment.hydrationChunkCount = count;
    attachment.hydrationChunks.set(index, Uint8Array.from(frame.payload));
  }

  private handleHydrationComplete(attachment: ClientAttachment, frame: TerminalBinaryFrame): void {
    const descriptor = TerminalHydrationDescriptorSchema().parse(
      JSON.parse(new TextDecoder().decode(frame.payload)),
    );
    if (descriptor.hydrationId !== frame.hydrationId) return;
    this.validateHydrationComplete(attachment, descriptor.chunkCount);
    const payload = collectHydrationPayload(attachment);
    this.applyHydration(attachment, frame.sessionId, descriptor, payload);
  }

  private validateHydrationComplete(attachment: ClientAttachment, expectedChunkCount: number): void {
    const declaredChunks = attachment.hydrationChunkCount ?? 0;
    if (!hasCompleteHydration(attachment, declaredChunks, expectedChunkCount)) {
      throw new Error("Terminal hydration is incomplete");
    }
    for (let index = 0; index < declaredChunks; index += 1) {
      if (!attachment.hydrationChunks.has(index)) {
        throw new Error("Terminal hydration chunks are not contiguous");
      }
    }
  }

  private applyHydration(
    attachment: ClientAttachment,
    sessionId: string,
    descriptor: HydrationDescriptor,
    payload: Uint8Array,
  ): void {
    attachment.hydrated = true;
    attachment.hydrationChunks.clear();
    attachment.hydrationDescriptor = descriptor;
    attachment.hydrationPayload = descriptor.mode === "checkpoint-delta" ? payload : null;
    const outputSeq = descriptor.lastOutputSeq ?? attachment.lastOutputSeq.toString();
    attachment.lastOutputSeq = BigInt(outputSeq);
    if (payload.byteLength > 0 && descriptor.mode !== "checkpoint-delta") {
      this.emitData({ ptyId: sessionId, payload, seq: Number(outputSeq) });
    }
    if (descriptor.gap) this.emitReconnectGap(sessionId, descriptor.gap);
    this.emitPendingOutput(attachment, sessionId);
  }

  private emitPendingOutput(attachment: ClientAttachment, sessionId: string): void {
    for (const output of attachment.pendingOutput.splice(0)) {
      attachment.lastOutputSeq = BigInt(output.seq);
      this.emitData({ ptyId: sessionId, payload: output.data, seq: Number(output.seq) });
    }
  }

  private handleOutput(attachment: ClientAttachment, frame: TerminalBinaryFrame): void {
    if (!attachment.hydrated) {
      attachment.hydrationOutputCount += 1;
      attachment.pendingOutput.push({ seq: frame.primarySeq, data: Uint8Array.from(frame.payload) });
      return;
    }
    attachment.lastOutputSeq = BigInt(frame.primarySeq);
    this.emitData({ ptyId: frame.sessionId, payload: frame.payload, seq: Number(frame.primarySeq) });
  }

  private handleGap(frame: TerminalBinaryFrame): void {
    const gap = TerminalGapSchema().parse(JSON.parse(new TextDecoder().decode(frame.payload)));
    this.emitReconnectGap(frame.sessionId, gap);
  }

  private handleExitBarrier(frame: TerminalBinaryFrame): void {
    const value = JSON.parse(new TextDecoder().decode(frame.payload)) as { exit: unknown };
    const exit = TerminalExitMetadataSchema().parse(value.exit);
    this.emitExit({
      ptyId: frame.sessionId,
      code: exit.code ?? 0,
      state: isFailedTerminalExit(exit.reason) ? "failed" : "exited",
      exit,
    });
  }

  private acceptFrameIdentity(
    attachment: ClientAttachment,
    frame: TerminalBinaryFrame,
  ): boolean {
    if (attachment.hostGeneration !== frame.hostGeneration) return false;
    if (
      attachment.attachmentEpoch !== "0" &&
      attachment.attachmentEpoch !== frame.attachmentEpoch
    ) {
      return false;
    }
    if (attachment.hydrated) {
      return frame.hydrationId === undefined || frame.hydrationId === attachment.hydrationId;
    }
    if (frame.hydrationId !== undefined) {
      if (
        attachment.attachmentEpoch !== "0" &&
        attachment.hydrationId !== frame.hydrationId
      ) {
        return false;
      }
      attachment.hydrationId = frame.hydrationId;
    }
    attachment.attachmentEpoch = frame.attachmentEpoch;
    return true;
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

  private emitData(event: TerminalDataEvent): void {
    for (const subscription of this.subscriptions.get(event.ptyId) ?? []) subscription.onData?.(event);
  }

  private emitExit(event: TerminalExitEvent): void {
    for (const subscription of this.subscriptions.get(event.ptyId) ?? []) subscription.onExit?.(event);
  }

  private emitReconnectGap(ptyId: string, gap?: TerminalGap): void {
    for (const subscription of this.subscriptions.get(ptyId) ?? []) subscription.onReconnectGap?.(gap);
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

function isValidHydrationChunk(
  attachment: ClientAttachment,
  index: number,
  count: number,
): boolean {
  return Number.isSafeInteger(index)
    && Number.isSafeInteger(count)
    && !attachment.hydrationChunks.has(index);
}

function hasCompleteHydration(
  attachment: ClientAttachment,
  declaredChunks: number,
  expectedChunkCount: number,
): boolean {
  return Number.isInteger(declaredChunks)
    && declaredChunks >= 0
    && attachment.hydrationChunks.size + attachment.hydrationOutputCount === expectedChunkCount;
}

function collectHydrationPayload(attachment: ClientAttachment): Uint8Array {
  const chunks = [...attachment.hydrationChunks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, chunk]) => chunk);
  return concatBytes(chunks);
}

function isFailedTerminalExit(reason: string): boolean {
  return reason === "host-crash"
    || reason === "containment-failure"
    || reason === "protocol-failure";
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
