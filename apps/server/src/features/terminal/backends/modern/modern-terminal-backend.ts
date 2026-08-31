import * as NodeCrypto from "node:crypto";
import type { WebSocket } from "ws";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import {
  TERMINAL_CHECKPOINT_CHUNK_BYTES,
  TERMINAL_CHECKPOINT_EXPIRES_AFTER_MS,
  TERMINAL_V1_METHODS,
  WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
  decodeTerminalFrame,
  encodeTerminalFrame,
  type TerminalBackendCapabilities,
  type TerminalBinaryFrame,
  type TerminalHealthSnapshot,
  type TerminalHydrationDescriptor,
} from "@mcode/contracts";
import type {
  PtyHostAdapter,
  PtyHostDiagnostics,
  PtyHostHealth,
} from "../../host/pty-host-adapter.js";
import type {
  TerminalRuntimeDeliveryEvent,
  TerminalSessionRuntime,
} from "../../sessions/terminal-session-runtime.js";
import {
  PreparedTerminalSessionLaunchError,
  PreparedTerminalSessionApprovalMismatchError,
  type PreparedTerminalSession,
  type TerminalSessionService,
} from "../../sessions/terminal-session-service.js";
import {
  TerminalBackend,
  TerminalBackendError,
  PreparedTerminalCommandStartError,
  PreparedTerminalCommandApprovalMismatchError,
  type TerminalBackendSender,
  type PreparedTerminalCommandRequest,
  type PreparedTerminalCommandSession,
  type TerminalReattachResult,
} from "../terminal-backend.js";
import { TerminalDiagnosticsService } from "../../diagnostics/terminal-diagnostics-service.js";
import { terminalPlatform } from "../../terminal-platform.js";

interface AttachmentRoute {
  readonly client: WebSocket;
  readonly sessionId: string;
  attachmentId: string;
  attachmentEpoch: string;
  hostGeneration: string;
  hydrationId: string;
  provisional: boolean;
  hydrated: boolean;
  readonly pendingDelivery: TerminalRuntimeDeliveryEvent[];
}

interface CheckpointUpload {
  readonly owner: WebSocket;
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly attachmentEpoch: string;
  readonly hostGeneration: string;
  readonly baseOutputSeq: string;
  readonly declaredBytes: number;
  readonly sha256: string;
  readonly expiresAt: number;
  readonly chunks: Map<number, Uint8Array>;
}

const terminalBackendError = (
  code: ConstructorParameters<typeof TerminalBackendError>[0],
  retry: ConstructorParameters<typeof TerminalBackendError>[1],
  message: string,
): TerminalBackendError => new TerminalBackendError(code, retry, message);

/** Joins Terminal v1 management and binary frames to the modern session runtime. */
export class ModernTerminalBackend extends TerminalBackend {
  private sender: TerminalBackendSender | null = null;
  private readonly attachments = new Map<string, AttachmentRoute>();
  private readonly uploads = new Map<string, CheckpointUpload>();
  private readonly selectedAt = new Date().toISOString();
  private readonly diagnostics: TerminalDiagnosticsService;
  private readonly startPromise: Promise<PtyHostHealth>;
  private readonly unsubscribeDelivery: () => void;

  constructor(
    private readonly sessions: TerminalSessionService,
    private readonly runtime: TerminalSessionRuntime,
    private readonly host: PtyHostAdapter & {
      health(): PtyHostHealth;
      diagnostics(): PtyHostDiagnostics;
    },
    private readonly sessionLimit: () => number,
    private readonly hostRuntime: HostRuntime,
    diagnostics?: TerminalDiagnosticsService,
    private readonly workspaceForThread?: (threadId: string) => string | null,
  ) {
    super();
    this.diagnostics = diagnostics ?? new TerminalDiagnosticsService({
      backend: () => "modern",
      health: () => this.healthSnapshot(),
    });
    this.startPromise = host.start();
    this.unsubscribeDelivery = runtime.subscribeDelivery?.((event) => this.deliver(event)) ?? (() => undefined);
  }

  /** Reports the immutable modern selection and current host health. */
  capabilities(): TerminalBackendCapabilities {
    const health = this.host.health();
    return {
      contractVersion: 1,
      backend: "modern",
      selectedAt: this.selectedAt,
      publicFrameVersion: 1,
      recovery: { replay: true, checkpoint: true, gap: true },
      host: { state: health.state, generation: health.hostGeneration },
      sessionLimit: this.sessionLimit(),
    };
  }

  /** Installs the directed WebSocket frame sender. */
  setSender(sender: TerminalBackendSender): void {
    this.sender = sender;
  }

  /** Returns the diagnostics service that owns live PTY host measurements. */
  getDiagnosticsService(): TerminalDiagnosticsService {
    return this.diagnostics;
  }

  /** Routes a strict Terminal v1 management request. */
  async routeV1(method: string, params: unknown, client: WebSocket): Promise<unknown> {
    const contract = TERMINAL_V1_METHODS[method as keyof typeof TERMINAL_V1_METHODS];
    if (!contract) throw new Error(`Unsupported Terminal v1 method: ${method}`);
    const input = contract.params.parse(params) as Record<string, unknown>;
    if (method === "terminal.capabilities") return this.capabilities();
    if (method === "terminal.diagnostics.report") return this.diagnostics.report(input);
    if (method === "terminal.diagnostics.getBundle") return this.diagnostics.getBundle();
    await this.ensureHostStarted();
    return this.routeSessionRequest(method, input, client);
  }

  private async ensureHostStarted(): Promise<void> {
    try {
      await this.startPromise;
    } catch (error) {
      throw new TerminalBackendError(
        "HOST_UNHEALTHY",
        "SAFE_RETRY",
        error instanceof Error ? error.message : "The Terminal host failed to start",
      );
    }
  }

  private async routeSessionRequest(
    method: string,
    input: Record<string, unknown>,
    client: WebSocket,
  ): Promise<unknown> {
    switch (method) {
      case "terminal.session.create":
        return this.sessions.createSession(input as Parameters<TerminalSessionService["createSession"]>[0]);
      case "terminal.session.list":
        return this.sessions.listSessions(input.scope as Parameters<TerminalSessionService["listSessions"]>[0]);
      case "terminal.session.attach":
        return this.attach(input, client);
      case "terminal.session.detach":
        this.requireAttachmentDetails(client, String(input.sessionId), String(input.attachmentId), String(input.attachmentEpoch));
        await this.runtime.detach(input as unknown as Parameters<TerminalSessionRuntime["detach"]>[0]);
        this.attachments.delete(String(input.sessionId));
        return { detached: true };
      case "terminal.session.close":
        return this.closeSession(input);
      case "terminal.session.hasChildren": {
        const snapshot = this.requireSession(String(input.sessionId));
        return this.host.inspectChildren(snapshot.sessionId, snapshot.hostGeneration);
      }
      case "terminal.session.checkpoint.begin":
        return this.beginCheckpointForAttachment(input, client);
      case "terminal.session.checkpoint.complete":
        return this.completeCheckpoint(input, client);
      default:
        throw new Error(`Terminal v1 method is outside the protected session path: ${method}`);
    }
  }

  private async closeSession(input: Record<string, unknown>): Promise<unknown> {
    const sessionId = String(input.sessionId);
    const closed = await this.sessions.closeSession(
      sessionId,
      input.reason as Parameters<TerminalSessionService["closeSession"]>[1],
    );
    this.publishExitBarrier(sessionId, closed.lastOutputSeq, closed.exit);
    this.cleanupSession(sessionId);
    return closed;
  }

  private publishExitBarrier(
    sessionId: string,
    lastOutputSeq: string,
    exit: { readonly code: number | null; readonly signal: number | null } | null,
  ): void {
    const route = this.attachments.get(sessionId);
    if (!route || route.provisional || !exit) return;
    this.send(route, {
      kind: "exitBarrier",
      primarySeq: lastOutputSeq,
      relatedSeq: lastOutputSeq,
      payload: jsonBytes({ finalOutputSeq: lastOutputSeq, exit }),
    });
  }

  private beginCheckpointForAttachment(input: Record<string, unknown>, client: WebSocket): unknown {
    this.requireAttachmentDetails(
      client,
      String(input.sessionId),
      String(input.attachmentId),
      String(input.attachmentEpoch),
      String(input.hostGeneration),
    );
    return this.beginCheckpoint(input, client);
  }

  private healthSnapshot(): TerminalHealthSnapshot {
    const health = this.host.health();
    const diagnostics = this.host.diagnostics();
    return {
      contractVersion: 1,
      state: health.state,
      hostGeneration: health.hostGeneration,
      activeSessions: Math.min(this.sessions.listSessions().length, 20),
      lastHeartbeatMsAgo: diagnostics.lastHeartbeatMsAgo,
      queueBytes: diagnostics.queueBytes,
      eventLoopLagMs: diagnostics.eventLoopLagMs,
      hostRssBytes: diagnostics.hostRssBytes,
    };
  }

  /** Applies a strict Terminal v1 attachment frame. */
  async handleV1Frame(client: WebSocket, bytes: Uint8Array): Promise<void> {
    const frame = decodeTerminalFrame(bytes);
    if (frame.kind === "checkpointChunk") {
      this.acceptCheckpointChunk(client, frame);
      return;
    }
    const route = this.requireAttachment(client, frame);
    if (frame.kind === "input") {
      await this.runtime.sendCommand({
        sessionId: route.sessionId,
        hostGeneration: route.hostGeneration,
        attachmentEpoch: route.attachmentEpoch,
        commandSeq: frame.primarySeq,
        kind: "input",
        data: frame.payload,
      });
      return;
    }
    if (frame.kind === "resize") {
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
      await this.runtime.sendCommand({
        sessionId: route.sessionId,
        hostGeneration: route.hostGeneration,
        attachmentEpoch: route.attachmentEpoch,
        commandSeq: frame.primarySeq,
        kind: "resize",
        data: { cols: view.getUint16(0, false), rows: view.getUint16(2, false) },
      });
      return;
    }
    if (frame.kind === "outputAck") {
      this.runtime.acknowledgeOutput({
        sessionId: route.sessionId,
        hostGeneration: route.hostGeneration,
        attachmentEpoch: route.attachmentEpoch,
        outputSeq: frame.primarySeq,
      });
      return;
    }
    throw terminalBackendError(
      "PROTOCOL_MISMATCH",
      "RESTART",
      `Terminal client frame kind is not accepted: ${frame.kind}`,
    );
  }

  /** Releases every attachment and upload owned by a disconnected client. */
  disconnectClient(client: WebSocket): void {
    for (const [sessionId, route] of this.attachments) {
      if (route.client !== client) continue;
      this.attachments.delete(sessionId);
      void this.runtime.detach({
        sessionId,
        attachmentId: route.attachmentId,
        attachmentEpoch: route.attachmentEpoch,
        reason: "disconnect",
      }).catch(() => undefined);
    }
    for (const [uploadId, upload] of this.uploads) {
      if (upload.owner === client) this.uploads.delete(uploadId);
    }
  }

  private async attach(input: Record<string, unknown>, client: WebSocket): Promise<unknown> {
    const provisional: AttachmentRoute = {
      client,
      sessionId: String(input.sessionId),
      attachmentId: String(input.attachmentId),
      attachmentEpoch: "",
      hostGeneration: String(input.hostGeneration),
      hydrationId: "",
      provisional: true,
      hydrated: false,
      pendingDelivery: [],
    };
    this.attachments.set(provisional.sessionId, provisional);
    try {
      const descriptor = await this.runtime.attach({
        sessionId: provisional.sessionId,
        attachmentId: provisional.attachmentId,
        hostGeneration: provisional.hostGeneration,
        lastOutputSeq: String(input.lastOutputSeq),
        lastCommandSeq: String(input.lastCommandSeq),
        checkpointSeq: input.checkpointSeq === undefined ? null : String(input.checkpointSeq),
      });
      provisional.attachmentId = descriptor.attachmentId;
      provisional.attachmentEpoch = descriptor.attachmentEpoch;
      provisional.hostGeneration = descriptor.hostGeneration;
      provisional.hydrationId = descriptor.hydrationId;
      provisional.provisional = false;
      this.sendHydration(provisional);
      provisional.hydrated = true;
      this.flushPendingDelivery(provisional);
      return descriptor;
    } catch (error) {
      if (this.attachments.get(provisional.sessionId) === provisional) this.attachments.delete(provisional.sessionId);
      throw error;
    }
  }

  private sendHydration(route: AttachmentRoute): void {
    const hydration = this.runtime.consumeHydration({
      sessionId: route.sessionId,
      hostGeneration: route.hostGeneration,
      attachmentEpoch: route.attachmentEpoch,
      hydrationId: route.hydrationId,
    });
    this.sendCheckpointChunks(route, hydration.checkpoint?.data ?? new Uint8Array());
    this.sendReplayOutput(route, hydration.output);
    this.sendHydrationGap(route, hydration.descriptor.gap);
    this.send(route, {
      kind: "hydrationComplete",
      hydrationId: route.hydrationId,
      primarySeq: hydration.descriptor.lastOutputSeq ?? "0",
      relatedSeq: "0",
      payload: jsonBytes(hydration.descriptor),
    });
  }

  private sendCheckpointChunks(route: AttachmentRoute, data: Uint8Array): void {
    const chunks = chunkBytes(data);
    chunks.forEach((payload, index) => this.send(route, {
      kind: "hydrationChunk",
      hydrationId: route.hydrationId,
      primarySeq: String(index),
      relatedSeq: String(chunks.length),
      payload,
    }));
  }

  private sendReplayOutput(
    route: AttachmentRoute,
    output: ReadonlyArray<{ readonly outputSeq: string; readonly data: Uint8Array }>,
  ): void {
    for (const chunk of chunkReplayOutput(output)) {
      this.send(route, {
        kind: "output",
        hydrationId: route.hydrationId,
        primarySeq: chunk.outputSeq,
        relatedSeq: "0",
        payload: chunk.data,
      });
    }
  }

  private sendHydrationGap(
    route: AttachmentRoute,
    gap: TerminalHydrationDescriptor["gap"],
  ): void {
    if (!gap) return;
    this.send(route, {
      kind: "gap",
      hydrationId: route.hydrationId,
      primarySeq: gap.firstMissingSeq,
      relatedSeq: gap.lastMissingSeq,
      payload: jsonBytes(gap),
    });
  }

  private flushPendingDelivery(route: AttachmentRoute): void {
    for (const event of route.pendingDelivery.splice(0)) {
      if (event.attachmentEpoch === route.attachmentEpoch) this.deliver(event);
    }
  }

  private beginCheckpoint(input: Record<string, unknown>, client: WebSocket): unknown {
    const uploadId = NodeCrypto.randomUUID();
    this.uploads.set(uploadId, {
      owner: client,
      sessionId: String(input.sessionId),
      attachmentId: String(input.attachmentId),
      attachmentEpoch: String(input.attachmentEpoch),
      hostGeneration: String(input.hostGeneration),
      baseOutputSeq: String(input.baseOutputSeq),
      declaredBytes: Number(input.declaredBytes),
      sha256: String(input.sha256),
      expiresAt: Date.now() + TERMINAL_CHECKPOINT_EXPIRES_AFTER_MS,
      chunks: new Map(),
    });
    return { uploadId, chunkBytes: TERMINAL_CHECKPOINT_CHUNK_BYTES, expiresAfterMs: TERMINAL_CHECKPOINT_EXPIRES_AFTER_MS };
  }

  private cleanupSession(sessionId: string): void {
    this.attachments.delete(sessionId);
    for (const [uploadId, upload] of this.uploads) {
      if (upload.sessionId === sessionId) this.uploads.delete(uploadId);
    }
  }

  private acceptCheckpointChunk(client: WebSocket, frame: TerminalBinaryFrame): void {
    const upload = this.requireCheckpointUpload(frame.uploadId, client);
    const route = this.requireAttachment(client, frame);
    if (!this.matchesAttachment(upload, route)) {
      throw terminalBackendError("STALE_ATTACHMENT", "REATTACH", "Terminal checkpoint attachment is stale");
    }
    const index = Number(frame.primarySeq);
    const expectedChunks = this.validateCheckpointChunkPosition(upload, frame, index);
    this.validateCheckpointChunkSize(upload, frame.payload, index, expectedChunks);
    upload.chunks.set(index, Uint8Array.from(frame.payload));
  }

  private async completeCheckpoint(input: Record<string, unknown>, client: WebSocket): Promise<unknown> {
    const upload = this.takeCheckpointUpload(String(input.uploadId), client);
    this.requireAttachmentDetails(
      client,
      upload.sessionId,
      upload.attachmentId,
      upload.attachmentEpoch,
      upload.hostGeneration,
    );
    if (!this.matchesCheckpointCompletion(input, upload)) {
      throw terminalBackendError("STALE_ATTACHMENT", "REATTACH", "Terminal checkpoint attachment is stale");
    }
    this.validateCheckpointCompleteness(upload);
    const data = concatBytes([...upload.chunks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value));
    const sha256 = NodeCrypto.createHash("sha256").update(data).digest("hex");
    this.validateCheckpointContents(input, upload, data, sha256);
    await this.runtime.saveCheckpoint({
      sessionId: upload.sessionId,
      hostGeneration: upload.hostGeneration,
      attachmentEpoch: upload.attachmentEpoch,
      baseOutputSeq: upload.baseOutputSeq,
      data,
      sha256,
    });
    return { accepted: true, checkpointThroughSeq: upload.baseOutputSeq };
  }

  private requireCheckpointUpload(uploadId: string | undefined, client: WebSocket): CheckpointUpload {
    const upload = uploadId ? this.uploads.get(uploadId) : null;
    if (!upload || upload.owner !== client || upload.expiresAt < Date.now()) {
      throw terminalBackendError("CHECKPOINT_REJECTED", "REATTACH", "Terminal checkpoint upload is unavailable");
    }
    return upload;
  }

  private takeCheckpointUpload(uploadId: string, client: WebSocket): CheckpointUpload {
    const upload = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (!upload || upload.owner !== client || upload.expiresAt < Date.now()) {
      throw terminalBackendError("CHECKPOINT_REJECTED", "REATTACH", "Terminal checkpoint upload is unavailable");
    }
    return upload;
  }

  private matchesAttachment(upload: CheckpointUpload, route: AttachmentRoute): boolean {
    return upload.sessionId === route.sessionId &&
      upload.attachmentId === route.attachmentId &&
      upload.attachmentEpoch === route.attachmentEpoch &&
      upload.hostGeneration === route.hostGeneration;
  }

  private validateCheckpointChunkPosition(
    upload: CheckpointUpload,
    frame: TerminalBinaryFrame,
    index: number,
  ): number {
    const expectedChunks = Math.ceil(upload.declaredBytes / TERMINAL_CHECKPOINT_CHUNK_BYTES);
    if (Number(frame.relatedSeq) !== expectedChunks || index >= expectedChunks || upload.chunks.has(index)) {
      throw new TerminalBackendError("CHECKPOINT_REJECTED", "REATTACH", "Terminal checkpoint chunks are not contiguous");
    }
    return expectedChunks;
  }

  private validateCheckpointChunkSize(
    upload: CheckpointUpload,
    payload: Uint8Array,
    index: number,
    expectedChunks: number,
  ): void {
    const expectedBytes = index === expectedChunks - 1
      ? upload.declaredBytes - index * TERMINAL_CHECKPOINT_CHUNK_BYTES
      : TERMINAL_CHECKPOINT_CHUNK_BYTES;
    if (payload.byteLength !== expectedBytes) {
      throw new TerminalBackendError("CHECKPOINT_REJECTED", "REATTACH", "Terminal checkpoint chunk size is invalid");
    }
  }

  private matchesCheckpointCompletion(
    input: Record<string, unknown>,
    upload: CheckpointUpload,
  ): boolean {
    return String(input.sessionId) === upload.sessionId &&
      String(input.attachmentId) === upload.attachmentId &&
      String(input.attachmentEpoch) === upload.attachmentEpoch &&
      String(input.hostGeneration) === upload.hostGeneration;
  }

  private validateCheckpointCompleteness(upload: CheckpointUpload): void {
    const expectedChunks = Math.ceil(upload.declaredBytes / TERMINAL_CHECKPOINT_CHUNK_BYTES);
    const incomplete = upload.chunks.size !== expectedChunks ||
      [...Array(expectedChunks).keys()].some((index) => !upload.chunks.has(index));
    if (incomplete) {
      throw new TerminalBackendError("CHECKPOINT_REJECTED", "REATTACH", "Terminal checkpoint upload is incomplete");
    }
  }

  private validateCheckpointContents(
    input: Record<string, unknown>,
    upload: CheckpointUpload,
    data: Uint8Array,
    sha256: string,
  ): void {
    const invalid = data.byteLength !== upload.declaredBytes ||
      data.byteLength !== Number(input.totalBytes) ||
      sha256 !== upload.sha256 ||
      sha256 !== input.sha256;
    if (invalid) {
      throw terminalBackendError("CHECKPOINT_REJECTED", "REATTACH", "Terminal checkpoint upload failed validation");
    }
  }

  private deliver(event: TerminalRuntimeDeliveryEvent): void {
    const route = this.attachments.get(event.sessionId);
    if (!route) return;
    if (route.provisional) {
      route.pendingDelivery.push(event);
      return;
    }
    if (route.attachmentEpoch !== event.attachmentEpoch || route.hostGeneration !== event.hostGeneration) return;
    if (!route.hydrated) {
      route.pendingDelivery.push(event);
      return;
    }
    if (event.kind === "output") {
      this.send(route, { kind: "output", primarySeq: event.outputSeq, relatedSeq: "0", payload: event.data });
    } else if (event.kind === "commandAck") {
      this.send(route, { kind: "commandAck", primarySeq: event.commandSeq, relatedSeq: event.outputSeq, payload: new Uint8Array() });
    } else {
      this.send(route, {
        kind: "exitBarrier",
        primarySeq: event.finalOutputSeq,
        relatedSeq: event.acknowledgedOutputSeq,
        payload: jsonBytes({ finalOutputSeq: event.finalOutputSeq, exit: event.exit }),
      });
    }
  }

  private send(route: AttachmentRoute, frame: Pick<TerminalBinaryFrame, "kind" | "primarySeq" | "relatedSeq" | "payload"> & { hydrationId?: string }): void {
    if (!this.sender?.frame) throw new Error("Terminal v1 sender is not configured");
    this.sender.frame(route.client, encodeTerminalFrame({
      ...frame,
      sessionId: route.sessionId,
      attachmentId: route.attachmentId,
      hostGeneration: route.hostGeneration,
      attachmentEpoch: route.attachmentEpoch,
    }));
  }

  private requireAttachment(client: WebSocket, frame: TerminalBinaryFrame): AttachmentRoute {
    const route = this.attachments.get(frame.sessionId);
    if (!route || route.client !== client || route.attachmentId !== frame.attachmentId || route.attachmentEpoch !== frame.attachmentEpoch || route.hostGeneration !== frame.hostGeneration) {
      throw terminalBackendError("STALE_ATTACHMENT", "REATTACH", "Terminal attachment is stale");
    }
    return route;
  }

  private requireAttachmentDetails(
    client: WebSocket,
    sessionId: string,
    attachmentId: string,
    attachmentEpoch: string,
    hostGeneration?: string,
  ): AttachmentRoute {
    const route = this.attachments.get(sessionId);
    if (
      !route ||
      route.client !== client ||
      route.attachmentId !== attachmentId ||
      route.attachmentEpoch !== attachmentEpoch ||
      (hostGeneration !== undefined && route.hostGeneration !== hostGeneration)
    ) {
      throw terminalBackendError("STALE_ATTACHMENT", "REATTACH", "Terminal attachment is stale");
    }
    return route;
  }

  private requireSession(sessionId: string) {
    const snapshot = this.runtime.getSnapshot(sessionId);
    if (!snapshot) throw new Error("Terminal session was not found");
    return snapshot;
  }

  create(): never { throw new Error("Use terminal.session.create"); }
  pause(): never { throw new Error("Use terminal.session.detach"); }
  resume(): never { throw new Error("Use terminal.session.attach"); }
  onBufferedAmountTick(): void {}
  write(): never { throw new Error("Use Terminal v1 input frames"); }
  resize(): never { throw new Error("Use Terminal v1 resize frames"); }
  kill(): Promise<void> { return Promise.reject(new Error("Use terminal.session.close")); }
  async killByThread(threadId: string): Promise<void> {
    const workspaceId = this.workspaceForThread?.(threadId);
    if (!workspaceId) throw new Error("Terminal Thread is unavailable");
    await this.sessions.closeScope({ kind: "thread", workspaceId, threadId }, "scope-reset");
  }
  async shutdown(): Promise<void> { this.unsubscribeDelivery(); this.sessions.dispose(); await this.runtime.shutdown(); }
  setGracefulKill(): void {}
  reattach(): TerminalReattachResult { throw new Error("Use terminal.session.attach"); }
  checkpoint(): { accepted: boolean } { throw new Error("Use Terminal v1 checkpoint methods"); }
  listActiveSessions(): Array<{ ptyId: string; threadId: string }> { throw new Error("Use terminal.session.list"); }
  hasChildren(): Promise<{ hasChildren: boolean }> { return Promise.reject(new Error("Use terminal.session.hasChildren")); }

  /** Starts an exact hidden command through the modern host session and its app-wide capacity guard. */
  async startPreparedCommand(input: PreparedTerminalCommandRequest): Promise<PreparedTerminalCommandSession> {
    const workspaceId = this.workspaceForThread?.(input.threadId);
    if (!workspaceId) throw new Error("Prepared command Thread is unavailable");
    await this.startPromise;
    const created = await this.createPreparedSession(input, workspaceId);
    return this.createPreparedCommandSession(created, input);
  }

  private async createPreparedSession(
    input: PreparedTerminalCommandRequest,
    workspaceId: string,
  ): Promise<PreparedTerminalSession> {
    try {
      return await this.sessions.createPreparedSession({
        scope: { kind: "thread", workspaceId, threadId: input.threadId },
        script: input.script,
        expectedLaunch: input.expectedLaunch,
      });
    } catch (error) {
      if (error instanceof PreparedTerminalSessionApprovalMismatchError) {
        throw new PreparedTerminalCommandApprovalMismatchError(
          this.preparedCommandSnapshot(input.script, error.plan),
        );
      }
      if (error instanceof PreparedTerminalSessionLaunchError) {
        throw new PreparedTerminalCommandStartError(
          this.preparedCommandSnapshot(input.script, error.plan),
          error,
        );
      }
      throw error;
    }
  }

  private preparedCommandSnapshot(
    script: string,
    plan: PreparedTerminalSessionApprovalMismatchError["plan"],
  ): ConstructorParameters<typeof PreparedTerminalCommandApprovalMismatchError>[0] {
    return {
      platform: terminalPlatform(this.hostRuntime.platform),
      script,
      checkoutPath: plan.checkoutPath,
      terminal: {
        executable: plan.terminal.executable,
        arguments: [...plan.terminal.arguments],
      },
      environmentNames: [...plan.environmentNames],
    };
  }

  private createPreparedCommandSession(
    created: PreparedTerminalSession,
    input: PreparedTerminalCommandRequest,
  ): PreparedTerminalCommandSession {
    const outputListeners = new Set<(data: Uint8Array) => void>();
    const exitListeners = new Set<(exit: { readonly exitCode: number | null }) => void>();
    let retainedOutput: Uint8Array[] = [];
    let retainedOutputBytes = 0;
    const retainOutput = (data: Uint8Array) => {
      const copy = Uint8Array.from(data);
      if (copy.byteLength === 0) return;
      if (copy.byteLength >= WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES) {
        retainedOutput = [copy.slice(copy.byteLength - WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES)];
        retainedOutputBytes = WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES;
        return;
      }
      let discard = Math.max(
        0,
        retainedOutputBytes + copy.byteLength - WORKSPACE_ENVIRONMENT_ACTION_TRANSCRIPT_MAX_BYTES,
      );
      while (discard > 0 && retainedOutput.length > 0) {
        const first = retainedOutput[0]!;
        if (first.byteLength <= discard) {
          retainedOutput.shift();
          retainedOutputBytes -= first.byteLength;
          discard -= first.byteLength;
        } else {
          retainedOutput[0] = first.subarray(discard);
          retainedOutputBytes -= discard;
          discard = 0;
        }
      }
      retainedOutput.push(copy);
      retainedOutputBytes += copy.byteLength;
    };
    let exited = false;
    let retainedExit: number | null | undefined;
    let unsubscribe: () => void = () => undefined;
    const publishExit = (exitCode: number | null) => {
      if (exited) return;
      exited = true;
      retainedExit = exitCode;
      unsubscribe();
      this.sessions.releasePreparedSession(created.session.sessionId);
      for (const listener of exitListeners) listener({ exitCode });
    };
    unsubscribe = this.runtime.subscribeHeadless((event) => {
      if (event.sessionId !== created.session.sessionId) return;
      if (event.kind === "output") {
        retainOutput(event.data);
        for (const listener of outputListeners) listener(event.data);
      } else {
        publishExit(event.exitCode);
      }
    });
    const replay = this.runtime.readHeadlessReplay(created.session.sessionId);
    if (replay) {
      for (const output of replay.output) retainOutput(output);
      if (replay.exitCode !== undefined) publishExit(replay.exitCode);
    }
    return {
      terminalSessionId: created.session.sessionId,
      snapshot: {
        platform: terminalPlatform(this.hostRuntime.platform),
        script: input.script,
        checkoutPath: created.checkoutPath,
        terminal: {
          executable: created.session.launch.resolvedProfile.executable,
          arguments: created.session.launch.arguments,
        },
        environmentNames: [...created.environmentNames],
      },
      onOutput: (listener) => {
        outputListeners.add(listener);
        for (const data of retainedOutput) listener(data);
        return () => outputListeners.delete(listener);
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        if (retainedExit !== undefined) listener({ exitCode: retainedExit });
        return () => exitListeners.delete(listener);
      },
      stop: async () => {
        if (exited) return;
        const closed = await this.sessions.closeSession(created.session.sessionId, "user");
        publishExit(closed.exit?.code ?? null);
      },
    };
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function concatBytes(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

function chunkBytes(value: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < value.byteLength; offset += TERMINAL_CHECKPOINT_CHUNK_BYTES) {
    chunks.push(value.slice(offset, offset + TERMINAL_CHECKPOINT_CHUNK_BYTES));
  }
  return chunks;
}

function chunkReplayOutput(
  outputs: ReadonlyArray<{ readonly outputSeq: string; readonly data: Uint8Array }>,
): Array<{ readonly outputSeq: string; readonly data: Uint8Array }> {
  const chunks: Array<{ outputSeq: string; data: Uint8Array }> = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let outputSeq = "0";
  const flush = () => {
    if (pendingBytes === 0) return;
    chunks.push({ outputSeq, data: concatBytes(pending) });
    pending = [];
    pendingBytes = 0;
  };
  for (const output of outputs) {
    let offset = 0;
    while (offset < output.data.byteLength) {
      const capacity = TERMINAL_CHECKPOINT_CHUNK_BYTES - pendingBytes;
      const part = output.data.slice(offset, offset + capacity);
      pending.push(part);
      pendingBytes += part.byteLength;
      outputSeq = output.outputSeq;
      offset += part.byteLength;
      if (pendingBytes === TERMINAL_CHECKPOINT_CHUNK_BYTES) flush();
    }
  }
  flush();
  return chunks;
}
