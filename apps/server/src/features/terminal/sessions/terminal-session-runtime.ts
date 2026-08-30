import { createHash, randomUUID } from "node:crypto";
import type {
  TerminalAttachmentDescriptor,
  TerminalErrorCode,
  TerminalLaunchSnapshot,
  TerminalRetryClass,
  TerminalScope,
  TerminalSessionSnapshot,
} from "@mcode/contracts";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TerminalLaunchSnapshotSchema,
  TerminalScopeSchema,
  TerminalSessionSnapshotSchema,
  TerminalTimestampSchema,
  TerminalU64Schema,
  TerminalUuidSchema,
} from "@mcode/contracts";
import type { ZodType } from "zod";
import type { PtyHostAdapter } from "../host/pty-host-adapter.js";
import {
  PTY_HOST_MAX_RETAINED_RECORDS,
  PtyHostServerMessageSchema,
  type PtyHostEvent,
} from "../host/pty-host-protocol.js";
import {
  replayBytesForScrollback,
  TerminalReplayBuffer,
  type TerminalHydration,
} from "./terminal-replay-buffer.js";

/** Runtime request that reserves and creates one shell session. */
export interface CreateRuntimeSession {
  readonly sessionId: string;
  readonly scope: TerminalScope;
  readonly launch: TerminalLaunchSnapshot;
  readonly hostGeneration: string;
  readonly cwd: string;
  readonly protectedEnv: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

/** Runtime request that acquires one attachment lease. */
export interface AttachRuntimeSession {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly hostGeneration: string;
  readonly lastOutputSeq: string;
  readonly lastCommandSeq: string;
  readonly checkpointSeq: string | null;
}

/** Ordered input or resize command from the current attachment. */
export type TerminalAttachmentCommand =
  | {
      readonly sessionId: string;
      readonly hostGeneration: string;
      readonly attachmentEpoch: string;
      readonly commandSeq: string;
      readonly kind: "input";
      readonly data: Uint8Array;
    }
  | {
      readonly sessionId: string;
      readonly hostGeneration: string;
      readonly attachmentEpoch: string;
      readonly commandSeq: string;
      readonly kind: "resize";
      readonly data: { readonly cols: number; readonly rows: number };
    };

/** Cumulative output acknowledgement from the current attachment. */
export interface TerminalOutputAcknowledgement {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly attachmentEpoch: string;
  readonly outputSeq: string;
}

/** Validated renderer checkpoint accepted by the runtime seam. */
export interface ValidatedTerminalCheckpoint {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly attachmentEpoch: string;
  readonly baseOutputSeq: string;
  readonly data: Uint8Array;
  readonly sha256: string;
}

/** Runtime request that releases one attachment lease. */
export interface DetachRuntimeSession {
  readonly sessionId: string;
  readonly attachmentId: string;
  readonly attachmentEpoch: string;
  readonly reason: "hide" | "switch" | "disconnect";
}

/** Runtime request that starts the attachment-independent close barrier. */
export interface CloseRuntimeSession {
  readonly sessionId: string;
  readonly reason: "user" | "scope-reset" | "workspace-delete" | "app-shutdown";
}

/** Runtime request that consumes the prepared hydration for one attachment. */
export interface ConsumeRuntimeHydration {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly attachmentEpoch: string;
  readonly hydrationId: string;
}

/** Deep modern-session seam that owns lifecycle, ordering, replay, and exit barriers. */
export interface TerminalSessionRuntime {
  createSession(input: CreateRuntimeSession): Promise<TerminalSessionSnapshot>;
  attach(input: AttachRuntimeSession): Promise<TerminalAttachmentDescriptor>;
  consumeHydration(input: ConsumeRuntimeHydration): TerminalHydration;
  sendCommand(command: TerminalAttachmentCommand): Promise<void>;
  acknowledgeOutput(ack: TerminalOutputAcknowledgement): void;
  saveCheckpoint(checkpoint: ValidatedTerminalCheckpoint): Promise<void>;
  detach(input: DetachRuntimeSession): Promise<void>;
  close(input: CloseRuntimeSession): Promise<TerminalSessionSnapshot>;
  getSnapshot(sessionId: string): TerminalSessionSnapshot | null;
  subscribeDelivery?(listener: (event: TerminalRuntimeDeliveryEvent) => void): () => void;
  subscribeHeadless(listener: (event: TerminalRuntimeHeadlessEvent) => void): () => void;
  readHeadlessReplay(sessionId: string): TerminalRuntimeHeadlessReplay | null;
  /** Discards a headless session after it reaches a final runtime state. */
  discardExitedSession(sessionId: string): boolean;
  applySettings?(settings: { readonly scrollback: number }): void;
  shutdown(): Promise<void>;
}

/** Output and exit events observed without a renderer attachment for private command sessions. */
export type TerminalRuntimeHeadlessEvent =
  | { readonly kind: "output"; readonly sessionId: string; readonly data: Uint8Array }
  | { readonly kind: "exit"; readonly sessionId: string; readonly exitCode: number | null };

/** Bounded output and optional exit retained before a headless owner attaches. */
export interface TerminalRuntimeHeadlessReplay {
  readonly output: readonly Uint8Array[];
  readonly exitCode: number | null | undefined;
}

/** Generation-bound runtime event ready for the public attachment transport. */
export type TerminalRuntimeDeliveryEvent =
  | { readonly kind: "commandAck"; readonly sessionId: string; readonly hostGeneration: string; readonly attachmentEpoch: string; readonly commandSeq: string; readonly outputSeq: string }
  | { readonly kind: "output"; readonly sessionId: string; readonly hostGeneration: string; readonly attachmentEpoch: string; readonly outputSeq: string; readonly data: Uint8Array }
  | { readonly kind: "exitBarrier"; readonly sessionId: string; readonly hostGeneration: string; readonly attachmentEpoch: string; readonly finalOutputSeq: string; readonly acknowledgedOutputSeq: string; readonly exit: NonNullable<TerminalSessionSnapshot["exit"]> };

interface AttachmentLease {
  readonly attachmentId: string;
  readonly epoch: bigint;
  acknowledgedOutputSeq: bigint;
  readonly hydrationThroughSeq: bigint;
  hydrationComplete: boolean;
  pendingHydration: TerminalHydration | null;
}

interface RuntimeSession {
  readonly sessionId: string;
  readonly scope: TerminalScope;
  readonly launch: TerminalLaunchSnapshot;
  readonly hostGeneration: string;
  readonly createdAt: string;
  state: "starting" | "running" | "exiting" | "exited" | "failed";
  attachment: AttachmentLease | null;
  nextAttachmentEpoch: bigint;
  acceptedCommandSeq: bigint;
  appliedCommandSeq: bigint;
  receivedOutputSeq: bigint;
  unacknowledgedInputBytes: number;
  readonly inputBytesBySequence: Map<bigint, number>;
  readonly attachmentEpochBySequence: Map<bigint, bigint>;
  commandTail: Promise<void>;
  inputStallTimer: ReturnType<typeof setTimeout> | null;
  exitFlushTimer: ReturnType<typeof setTimeout> | null;
  deliveryUnknown: boolean;
  revokedAttachmentEpoch: bigint | null;
  readonly replay: TerminalReplayBuffer;
  pendingExit: {
    readonly finalOutputSeq: bigint;
    readonly code: number | null;
    readonly signal: number | null;
    readonly reason: NonNullable<TerminalSessionSnapshot["exit"]>["reason"];
  } | null;
  exit: TerminalSessionSnapshot["exit"];
}

/** Construction options for the modern Terminal session runtime. */
export interface ModernTerminalSessionRuntimeOptions {
  readonly host: PtyHostAdapter;
  readonly now?: () => Date;
  readonly createHydrationId?: () => string;
  readonly createCorrelationId?: () => string;
  readonly initialDimensions?: {
    readonly cols: number;
    readonly rows: number;
  };
  readonly replayCapacityBytes?: number;
}

const MAX_COMMAND_BYTES = 65_536;
const MAX_UNACKNOWLEDGED_INPUT_BYTES = 262_144;
const MAX_CHECKPOINT_BYTES = 8_388_608;
const INPUT_ACKNOWLEDGEMENT_TIMEOUT_MS = 2_000;
const EXIT_FLUSH_TIMEOUT_MS = 2_000;
const DEFAULT_INITIAL_DIMENSIONS = Object.freeze({ cols: 80, rows: 24 });
const DEFAULT_REPLAY_CAPACITY_BYTES = replayBytesForScrollback(1_000);
const u64 = TerminalU64Schema();
const uuid = TerminalUuidSchema();

const ERROR_MESSAGES: Readonly<Partial<Record<TerminalErrorCode, string>>> = {
  HOST_UNHEALTHY: "The Terminal host is unhealthy",
  SESSION_NOT_FOUND: "The Terminal session was not found",
  SESSION_NOT_RUNNING: "The Terminal session is not running",
  STALE_HOST_GENERATION: "The Terminal host generation is stale",
  STALE_ATTACHMENT: "The Terminal attachment is stale",
  COMMAND_OUT_OF_ORDER: "The Terminal command is out of order",
  INPUT_STALLED: "The Terminal input acknowledgement is stalled",
  INPUT_DELIVERY_UNKNOWN: "The Terminal input delivery is unknown",
  CHECKPOINT_REJECTED: "The Terminal checkpoint was rejected",
  CONTAINMENT_FAILED: "The Terminal process containment failed",
  EXIT_FLUSH_FAILED: "The Terminal exit barrier did not complete",
  PROTOCOL_MISMATCH: "The Terminal protocol message is invalid",
};

/** Typed failure raised when a runtime invariant rejects an operation. */
export class TerminalSessionRuntimeError extends Error {
  readonly correlationId: string;

  constructor(
    readonly code: TerminalErrorCode,
    readonly retry: TerminalRetryClass,
    createCorrelationId: () => string = () => `corr-${randomUUID()}`,
  ) {
    super(ERROR_MESSAGES[code] ?? "The Terminal runtime rejected the operation");
    this.name = "TerminalSessionRuntimeError";
    this.correlationId = createCorrelationId();
  }
}

/** Server-authoritative runtime for modern Terminal lifecycle and controller leases. */
export class ModernTerminalSessionRuntime implements TerminalSessionRuntime {
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly now: () => Date;
  private readonly createHydrationId: () => string;
  private readonly createCorrelationId: () => string;
  private readonly initialDimensions: { readonly cols: number; readonly rows: number };
  private readonly unsubscribeHost: () => void;
  private readonly deliveryListeners = new Set<(event: TerminalRuntimeDeliveryEvent) => void>();
  private readonly headlessListeners = new Set<(event: TerminalRuntimeHeadlessEvent) => void>();

  constructor(private readonly options: ModernTerminalSessionRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.createHydrationId = options.createHydrationId ?? randomUUID;
    this.createCorrelationId = options.createCorrelationId ?? (() => `corr-${randomUUID()}`);
    this.initialDimensions = options.initialDimensions ?? DEFAULT_INITIAL_DIMENSIONS;
    validateDimensions(this.initialDimensions, this.protocolError.bind(this));
    this.unsubscribeHost = options.host.subscribe((event) => this.onHostEvent(event));
  }

  /** Creates one contained PTY and exposes it only after the host reports readiness. */
  async createSession(input: CreateRuntimeSession): Promise<TerminalSessionSnapshot> {
    const request = this.parseCreateRequest(input);
    if (this.sessions.has(request.sessionId)) throw this.protocolError();
    const record: RuntimeSession = {
      sessionId: request.sessionId,
      scope: freezeScope(request.scope),
      launch: freezeLaunch(request.launch),
      hostGeneration: request.hostGeneration,
      createdAt: parseContract(
        TerminalTimestampSchema(),
        this.now().toISOString(),
        this.protocolError.bind(this),
      ),
      state: "starting",
      attachment: null,
      nextAttachmentEpoch: 1n,
      acceptedCommandSeq: 0n,
      appliedCommandSeq: 0n,
      receivedOutputSeq: 0n,
      unacknowledgedInputBytes: 0,
      inputBytesBySequence: new Map(),
      attachmentEpochBySequence: new Map(),
      commandTail: Promise.resolve(),
      inputStallTimer: null,
      exitFlushTimer: null,
      deliveryUnknown: false,
      revokedAttachmentEpoch: null,
      replay: new TerminalReplayBuffer(
        this.options.replayCapacityBytes ?? DEFAULT_REPLAY_CAPACITY_BYTES,
      ),
      pendingExit: null,
      exit: null,
    };
    this.sessions.set(request.sessionId, record);
    try {
      const running = await this.options.host.create({
        sessionId: request.sessionId,
        hostGeneration: request.hostGeneration,
        launch: record.launch,
        cwd: input.cwd,
        protectedEnv: input.protectedEnv,
        ...this.initialDimensions,
      });
      if (
        running.sessionId !== request.sessionId ||
        running.hostGeneration !== request.hostGeneration ||
        running.state !== "running"
      ) {
        throw this.protocolError();
      }
      if (record.state !== "starting") return this.snapshot(record);
      record.state = "running";
      this.applyPendingExit(record);
      return this.snapshot(record);
    } catch (error) {
      this.sessions.delete(request.sessionId);
      throw error instanceof TerminalSessionRuntimeError
        ? error
        : this.mapHostError(error, "HOST_UNHEALTHY", "NEW_SESSION");
    }
  }

  private parseCreateRequest(input: CreateRuntimeSession): {
    readonly sessionId: string;
    readonly hostGeneration: string;
    readonly scope: ReturnType<typeof TerminalScopeSchema>["_output"];
    readonly launch: ReturnType<typeof TerminalLaunchSnapshotSchema>["_output"];
  } {
    const sessionId = parseContract(uuid, input.sessionId, this.protocolError.bind(this));
    const hostGeneration = parseContract(u64, input.hostGeneration, this.protocolError.bind(this));
    const scope = parseContract(TerminalScopeSchema(), input.scope, this.protocolError.bind(this));
    const launch = parseContract(
      TerminalLaunchSnapshotSchema(),
      input.launch,
      this.protocolError.bind(this),
    );
    if (JSON.stringify(scope) !== JSON.stringify(launch.scope)) throw this.protocolError();
    this.validateHostCreateMessage(sessionId, hostGeneration, scope, launch, input);
    return { sessionId, hostGeneration, scope, launch };
  }

  private validateHostCreateMessage(
    sessionId: string,
    hostGeneration: string,
    scope: ReturnType<typeof TerminalScopeSchema>["_output"],
    launch: ReturnType<typeof TerminalLaunchSnapshotSchema>["_output"],
    input: CreateRuntimeSession,
  ): void {
    const parsed = PtyHostServerMessageSchema().safeParse({
      contractVersion: 1,
      kind: "create",
      sessionId,
      hostGeneration,
      scope,
      executable: launch.resolvedProfile.executable,
      arguments: launch.arguments,
      cwd: input.cwd,
      cols: this.initialDimensions.cols,
      rows: this.initialDimensions.rows,
      env: input.protectedEnv,
    });
    if (!parsed.success) throw this.protocolError();
  }

  /** Acquires a new controller epoch and revokes the prior attachment. */
  async attach(input: AttachRuntimeSession): Promise<TerminalAttachmentDescriptor> {
    // Retained tombstones remain attachable so a remounted Terminal can
    // hydrate completed output from the bounded replay/checkpoint state.
    const record = this.requireSession(input.sessionId);
    this.requireGeneration(record, input.hostGeneration);
    const attachmentId = parseContract(
      uuid,
      input.attachmentId,
      this.protocolError.bind(this),
    );
    const lastOutputSeq = parseSequence(input.lastOutputSeq, this.protocolError.bind(this));
    const lastCommandSeq = parseSequence(input.lastCommandSeq, this.protocolError.bind(this));
    if (
      lastOutputSeq > record.receivedOutputSeq ||
      lastCommandSeq > record.appliedCommandSeq
    ) {
      throw this.protocolError();
    }
    const checkpointSeq = input.checkpointSeq === null
      ? null
      : parseSequence(input.checkpointSeq, this.protocolError.bind(this));
    if (checkpointSeq !== null && checkpointSeq > record.receivedOutputSeq) {
      throw this.protocolError();
    }
    const epoch = record.nextAttachmentEpoch;
    record.nextAttachmentEpoch += 1n;
    if (record.attachment && record.unacknowledgedInputBytes > 0) {
      record.deliveryUnknown = true;
    }
    const hydrationId = parseContract(
      uuid,
      this.createHydrationId(),
      this.protocolError.bind(this),
    );
    const hydration = record.replay.hydrate({
      hydrationId,
      requestedAfterSeq: lastOutputSeq,
      checkpointSeq,
    });
    record.attachment = {
      attachmentId,
      epoch,
      acknowledgedOutputSeq: lastOutputSeq,
      hydrationThroughSeq: record.receivedOutputSeq,
      hydrationComplete: false,
      pendingHydration: hydration,
    };
    return Object.freeze({
      contractVersion: 1,
      sessionId: record.sessionId,
      attachmentId,
      attachmentEpoch: epoch.toString(),
      hostGeneration: record.hostGeneration,
      hydrationId,
      inputEnabled: false,
      serverHighBytes: 1_048_576,
      serverLowBytes: 262_144,
      clientHighBytes: 262_144,
      clientLowBytes: 65_536,
    });
  }

  /** Consumes the one bounded hydration prepared for the current attachment. */
  consumeHydration(input: ConsumeRuntimeHydration): TerminalHydration {
    const record = this.requireSession(input.sessionId);
    this.requireGeneration(record, input.hostGeneration);
    const attachment = this.requireAttachment(record, input.attachmentEpoch, "REATTACH");
    const hydrationId = parseContract(uuid, input.hydrationId, this.protocolError.bind(this));
    if (
      attachment.pendingHydration === null ||
      attachment.pendingHydration.descriptor.hydrationId !== hydrationId
    ) {
      throw this.error("STALE_ATTACHMENT", "REATTACH");
    }
    const hydration = attachment.pendingHydration;
    attachment.pendingHydration = null;
    return hydration;
  }

  /** Sends one input or resize command after all earlier accepted commands. */
  async sendCommand(command: TerminalAttachmentCommand): Promise<void> {
    const record = this.requireRunningSession(command.sessionId);
    const operation = record.commandTail.then(() => this.sendOrderedCommand(record, command));
    record.commandTail = operation.catch(() => undefined);
    return operation;
  }

  /** Records the current controller's highest contiguous renderer output write. */
  acknowledgeOutput(ack: TerminalOutputAcknowledgement): void {
    const record = this.requireSession(ack.sessionId);
    this.requireGeneration(record, ack.hostGeneration);
    const attachment = this.requireAttachment(record, ack.attachmentEpoch, "REATTACH");
    const outputSeq = parseSequence(ack.outputSeq, this.protocolError.bind(this));
    if (
      outputSeq < attachment.acknowledgedOutputSeq ||
      outputSeq > record.receivedOutputSeq
    ) {
      throw this.protocolError();
    }
    attachment.acknowledgedOutputSeq = outputSeq;
    if (
      outputSeq >= attachment.hydrationThroughSeq &&
      attachment.pendingHydration === null
    ) {
      attachment.hydrationComplete = true;
    }
    this.completeExitBarrier(record);
  }

  /** Retains one validated renderer checkpoint for the later hydration path. */
  async saveCheckpoint(checkpoint: ValidatedTerminalCheckpoint): Promise<void> {
    const record = this.requireSession(checkpoint.sessionId);
    this.requireGeneration(record, checkpoint.hostGeneration);
    const attachment = this.requireAttachment(
      record,
      checkpoint.attachmentEpoch,
      "REATTACH",
    );
    const baseOutputSeq = parseSequence(
      checkpoint.baseOutputSeq,
      this.protocolError.bind(this),
    );
    if (
      checkpoint.data.byteLength < 1 ||
      checkpoint.data.byteLength > MAX_CHECKPOINT_BYTES ||
      baseOutputSeq > record.receivedOutputSeq ||
      !/^[a-f0-9]{64}$/.test(checkpoint.sha256) ||
      createHash("sha256").update(checkpoint.data).digest("hex") !== checkpoint.sha256
    ) {
      throw this.error("CHECKPOINT_REJECTED", "REATTACH");
    }
    if (baseOutputSeq > attachment.acknowledgedOutputSeq) {
      throw this.error("CHECKPOINT_REJECTED", "REATTACH");
    }
    const nextCheckpoint = {
      baseOutputSeq,
      data: Uint8Array.from(checkpoint.data),
      sha256: checkpoint.sha256,
    };
    const installResult = record.replay.installCheckpoint({
      baseOutputSeq: baseOutputSeq.toString(),
      data: nextCheckpoint.data,
      sha256: nextCheckpoint.sha256,
    });
    if (installResult === "rejected") {
      throw this.error("CHECKPOINT_REJECTED", "REATTACH");
    }
  }

  /** Releases only the current controller lease and leaves the shell running. */
  async detach(input: DetachRuntimeSession): Promise<void> {
    const record = this.requireSession(input.sessionId, "SAFE_RETRY");
    const attachment = this.requireAttachment(record, input.attachmentEpoch, "SAFE_RETRY");
    const attachmentId = parseContract(
      uuid,
      input.attachmentId,
      this.protocolError.bind(this),
    );
    if (attachment.attachmentId !== attachmentId) {
      throw this.error("STALE_ATTACHMENT", "SAFE_RETRY");
    }
    if (record.unacknowledgedInputBytes > 0) {
      record.deliveryUnknown = true;
      record.revokedAttachmentEpoch = attachment.epoch;
      this.clearInputStallTimer(record);
    }
    record.attachment = null;
  }

  /** Starts the ordered host close barrier and returns its retained outcome. */
  async close(input: CloseRuntimeSession): Promise<TerminalSessionSnapshot> {
    const record = this.requireSession(input.sessionId, "SAFE_RETRY");
    if (record.state === "exited" || record.state === "failed") {
      const tombstone = this.snapshot(record);
      this.clearInputStallTimer(record);
      this.clearExitFlushTimer(record);
      this.sessions.delete(record.sessionId);
      return tombstone;
    }
    if (record.state === "exiting" && record.pendingExit) {
      record.attachment = null;
      this.clearInputStallTimer(record);
      this.completeExitBarrier(record);
      const closed = this.snapshot(record);
      this.sessions.delete(record.sessionId);
      return closed;
    }
    if (record.state !== "running") {
      throw this.error("SESSION_NOT_RUNNING", "SAFE_RETRY");
    }
    record.state = "exiting";
    record.attachment = null;
    this.clearInputStallTimer(record);
    await record.commandTail;
    const closeSeq = record.acceptedCommandSeq + 1n;
    try {
      await this.options.host.close({
        sessionId: record.sessionId,
        hostGeneration: record.hostGeneration,
        closeSeq: closeSeq.toString(),
        reason: input.reason,
      });
    } catch (error) {
      if (record.state === "exiting") record.state = "running";
      throw this.mapHostError(error, "HOST_UNHEALTHY", "SAFE_RETRY");
    }
    if (!record.exit) {
      this.failSession(record, "protocol-failure");
      throw this.error("EXIT_FLUSH_FAILED", "REATTACH");
    }
    const closed = this.snapshot(record);
    this.sessions.delete(record.sessionId);
    return closed;
  }

  /** Returns an immutable snapshot for a live session or tombstone. */
  getSnapshot(sessionId: string): TerminalSessionSnapshot | null {
    const record = this.sessions.get(sessionId);
    return record ? this.snapshot(record) : null;
  }

  /** Subscribes to validated live attachment delivery events. */
  subscribeDelivery(listener: (event: TerminalRuntimeDeliveryEvent) => void): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  /** Subscribes to output and exit events that must not require a renderer attachment. */
  subscribeHeadless(listener: (event: TerminalRuntimeHeadlessEvent) => void): () => void {
    this.headlessListeners.add(listener);
    return () => this.headlessListeners.delete(listener);
  }

  /** Returns bounded output and exit retained before a headless owner subscribes. */
  readHeadlessReplay(sessionId: string): TerminalRuntimeHeadlessReplay | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    const hydration = record.replay.hydrate({
      hydrationId: this.createHydrationId(),
      requestedAfterSeq: 0n,
      checkpointSeq: null,
    });
    return Object.freeze({
      output: Object.freeze(hydration.output.map(({ data }) => Uint8Array.from(data))),
      exitCode: record.exit ? record.exit.code : record.pendingExit?.code,
    });
  }

  /** Releases a finished headless terminal after its owner retained the bounded outcome. */
  discardExitedSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || (record.state !== "exited" && record.state !== "failed")) return false;
    this.clearInputStallTimer(record);
    this.clearExitFlushTimer(record);
    this.sessions.delete(sessionId);
    return true;
  }

  /** Applies the live replay bound without replacing active PTYs. */
  applySettings(settings: { readonly scrollback: number }): void {
    const capacity = replayBytesForScrollback(settings.scrollback);
    for (const record of this.sessions.values()) record.replay.resize(capacity);
  }

  /** Stops the host and releases all runtime-owned memory. */
  async shutdown(): Promise<void> {
    this.unsubscribeHost();
    this.deliveryListeners.clear();
    this.headlessListeners.clear();
    for (const record of this.sessions.values()) {
      this.clearInputStallTimer(record);
      this.clearExitFlushTimer(record);
    }
    await this.options.host.shutdown();
    this.sessions.clear();
  }

  private async sendOrderedCommand(
    record: RuntimeSession,
    command: TerminalAttachmentCommand,
  ): Promise<void> {
    const sequence = this.validateOrderedCommand(record, command);
    this.recordOrderedCommand(record, command, sequence);
    try {
      await this.options.host.send(command);
    } catch (error) {
      this.rollbackUnappliedCommand(record, sequence);
      throw this.mapHostError(error, "HOST_UNHEALTHY", "REATTACH");
    }
  }

  private validateOrderedCommand(
    record: RuntimeSession,
    command: TerminalAttachmentCommand,
  ): bigint {
    this.requireGeneration(record, command.hostGeneration);
    const attachment = this.requireAttachment(record, command.attachmentEpoch, "REATTACH");
    if (!attachment.hydrationComplete) throw this.error("SESSION_NOT_RUNNING", "REATTACH");
    const sequence = parseSequence(command.commandSeq, this.protocolError.bind(this));
    if (sequence !== record.acceptedCommandSeq + 1n) {
      throw this.error("COMMAND_OUT_OF_ORDER", "REATTACH");
    }
    this.validateCommandPayload(record, command);
    if (record.attachmentEpochBySequence.size >= PTY_HOST_MAX_RETAINED_RECORDS) {
      throw this.error("INPUT_STALLED", "REATTACH");
    }
    return sequence;
  }

  private validateCommandPayload(
    record: RuntimeSession,
    command: TerminalAttachmentCommand,
  ): void {
    if (command.kind !== "input") {
      validateDimensions(command.data, this.protocolError.bind(this));
      return;
    }
    if (command.data.byteLength < 1 || command.data.byteLength > MAX_COMMAND_BYTES) {
      throw this.protocolError();
    }
    if (record.unacknowledgedInputBytes + command.data.byteLength > MAX_UNACKNOWLEDGED_INPUT_BYTES) {
      throw this.error("INPUT_STALLED", "REATTACH");
    }
    if (record.deliveryUnknown) {
      throw this.error("INPUT_DELIVERY_UNKNOWN", "UNKNOWN_DELIVERY");
    }
  }

  private recordOrderedCommand(
    record: RuntimeSession,
    command: TerminalAttachmentCommand,
    sequence: bigint,
  ): void {
    record.acceptedCommandSeq = sequence;
    record.attachmentEpochBySequence.set(sequence, BigInt(command.attachmentEpoch));
    if (command.kind !== "input") return;
    record.inputBytesBySequence.set(sequence, command.data.byteLength);
    record.unacknowledgedInputBytes += command.data.byteLength;
    this.startInputStallTimer(record);
  }

  private rollbackUnappliedCommand(record: RuntimeSession, sequence: bigint): void {
    if (record.appliedCommandSeq >= sequence) return;
    record.acceptedCommandSeq -= 1n;
    record.attachmentEpochBySequence.delete(sequence);
    const bytes = record.inputBytesBySequence.get(sequence) ?? 0;
    record.inputBytesBySequence.delete(sequence);
    record.unacknowledgedInputBytes -= bytes;
    if (record.unacknowledgedInputBytes !== 0) return;
    this.clearInputStallTimer(record);
    record.deliveryUnknown = false;
    record.revokedAttachmentEpoch = null;
  }

  private onHostEvent(event: PtyHostEvent): void {
    if (this.handleHostFailureEvent(event)) return;
    if (!("sessionId" in event)) return;
    const record = this.sessions.get(event.sessionId);
    if (!record || event.hostGeneration !== record.hostGeneration) return;
    if (event.kind === "commandAck") return this.handleCommandAck(record, event);
    if (event.kind === "output") return this.handleOutput(record, event);
    if (event.kind === "exit") this.handleExit(record, event);
  }

  private handleHostFailureEvent(event: PtyHostEvent): boolean {
    if (event.kind !== "failure" || event.code !== "HOST_UNHEALTHY") return false;
    for (const record of this.sessions.values()) {
      if (record.hostGeneration === event.hostGeneration && this.isHostCrashCandidate(record)) {
        this.failSessionForHostCrash(record);
      }
    }
    return true;
  }

  private isHostCrashCandidate(record: RuntimeSession): boolean {
    return record.state === "running" || record.state === "exiting";
  }

  private handleCommandAck(
    record: RuntimeSession,
    event: Extract<PtyHostEvent, { kind: "commandAck" }>,
  ): void {
    this.applyCommandAcknowledgement(record, event);
    if (record.attachment?.epoch.toString() !== event.attachmentEpoch) return;
    this.publishDelivery({
      kind: "commandAck",
      sessionId: record.sessionId,
      hostGeneration: record.hostGeneration,
      attachmentEpoch: event.attachmentEpoch,
      commandSeq: event.appliedCommandSeq,
      outputSeq: event.appliedOutputSeq,
    });
  }

  private handleOutput(record: RuntimeSession, event: Extract<PtyHostEvent, { kind: "output" }>): void {
    if (!this.acceptsOutput(record)) return;
    try {
      const sequence = BigInt(event.outputSeq);
      const data = Buffer.from(event.dataBase64, "base64");
      record.replay.append(sequence, data);
      record.receivedOutputSeq = sequence;
      this.publishHeadless({ kind: "output", sessionId: record.sessionId, data: Uint8Array.from(data) });
      this.publishAttachedOutput(record, sequence, data);
    } catch {
      this.failSession(record, "protocol-failure");
    }
  }

  private acceptsOutput(record: RuntimeSession): boolean {
    return record.state === "starting" || record.state === "running" || record.state === "exiting";
  }

  private publishAttachedOutput(record: RuntimeSession, sequence: bigint, data: Uint8Array): void {
    if (!record.attachment) return;
    this.publishDelivery({
      kind: "output",
      sessionId: record.sessionId,
      hostGeneration: record.hostGeneration,
      attachmentEpoch: record.attachment.epoch.toString(),
      outputSeq: sequence.toString(),
      data: Uint8Array.from(data),
    });
  }

  private handleExit(record: RuntimeSession, event: Extract<PtyHostEvent, { kind: "exit" }>): void {
    if (record.state === "starting") {
      this.queueExit(record, event);
      return;
    }
    if (record.state === "running" || (record.state === "exiting" && !record.pendingExit)) {
      this.queueExit(record, event);
      this.applyPendingExit(record);
    }
  }

  private publishDelivery(event: TerminalRuntimeDeliveryEvent): void {
    for (const listener of this.deliveryListeners) listener(event);
  }

  private publishHeadless(event: TerminalRuntimeHeadlessEvent): void {
    for (const listener of this.headlessListeners) listener(event);
  }

  private queueExit(record: RuntimeSession, event: Extract<PtyHostEvent, { kind: "exit" }>): void {
    if (record.pendingExit || record.exit) return;
    record.pendingExit = Object.freeze({
      finalOutputSeq: BigInt(event.finalOutputSeq),
      code: event.code,
      signal: event.signal,
      reason: event.reason,
    });
  }

  private applyPendingExit(record: RuntimeSession): void {
    const pendingExit = record.pendingExit;
    if (!pendingExit) return;
    if (pendingExit.finalOutputSeq !== record.receivedOutputSeq) {
      this.failExitBarrier(record);
      return;
    }
    record.state = "exiting";
    if (record.attachment) {
      this.publishDelivery({
        kind: "exitBarrier",
        sessionId: record.sessionId,
        hostGeneration: record.hostGeneration,
        attachmentEpoch: record.attachment.epoch.toString(),
        finalOutputSeq: pendingExit.finalOutputSeq.toString(),
        acknowledgedOutputSeq: record.attachment.acknowledgedOutputSeq.toString(),
        exit: Object.freeze({
          code: pendingExit.code,
          signal: pendingExit.signal,
          reason: pendingExit.reason,
        }),
      });
    }
    this.completeExitBarrier(record);
    if (record.pendingExit && !record.exitFlushTimer) {
      record.exitFlushTimer = setTimeout(() => {
        record.exitFlushTimer = null;
        if (record.pendingExit) this.failExitBarrier(record);
      }, EXIT_FLUSH_TIMEOUT_MS);
    }
  }

  private completeExitBarrier(record: RuntimeSession): void {
    const pendingExit = record.pendingExit;
    if (!pendingExit) return;
    if (
      record.attachment &&
      record.attachment.acknowledgedOutputSeq < pendingExit.finalOutputSeq
    ) {
      return;
    }
    record.pendingExit = null;
    this.clearExitFlushTimer(record);
    record.state = pendingExit.reason === "host-crash" ||
        pendingExit.reason === "containment-failure" ||
        pendingExit.reason === "protocol-failure"
      ? "failed"
      : "exited";
    record.exit = Object.freeze({
      code: pendingExit.code,
      signal: pendingExit.signal,
      reason: pendingExit.reason,
    });
    this.publishHeadless({ kind: "exit", sessionId: record.sessionId, exitCode: record.exit.code });
  }

  private failExitBarrier(record: RuntimeSession): void {
    record.pendingExit = null;
    this.clearExitFlushTimer(record);
    this.failSession(record, "protocol-failure");
  }

  private failSession(record: RuntimeSession, reason: "host-crash" | "protocol-failure"): void {
    if (record.state === "exited" || record.state === "failed") return;
    record.state = "failed";
    record.exit = Object.freeze({
      code: null,
      signal: null,
      reason,
    });
    this.publishHeadless({ kind: "exit", sessionId: record.sessionId, exitCode: null });
  }

  private failSessionForHostCrash(record: RuntimeSession): void {
    record.attachment = null;
    record.pendingExit = null;
    this.clearInputStallTimer(record);
    this.clearExitFlushTimer(record);
    this.failSession(record, "host-crash");
  }

  private applyCommandAcknowledgement(
    record: RuntimeSession,
    event: Extract<PtyHostEvent, { kind: "commandAck" }>,
  ): void {
    const sequence = BigInt(event.appliedCommandSeq);
    if (
      sequence < record.appliedCommandSeq ||
      sequence > record.acceptedCommandSeq ||
      record.attachmentEpochBySequence.get(sequence)?.toString() !== event.attachmentEpoch
    ) {
      return;
    }
    record.appliedCommandSeq = sequence;
    for (const [commandSeq, bytes] of record.inputBytesBySequence) {
      if (commandSeq > sequence) break;
      record.inputBytesBySequence.delete(commandSeq);
      record.unacknowledgedInputBytes -= bytes;
    }
    for (const commandSeq of record.attachmentEpochBySequence.keys()) {
      if (commandSeq > sequence) break;
      record.attachmentEpochBySequence.delete(commandSeq);
    }
    if (record.unacknowledgedInputBytes === 0) {
      this.clearInputStallTimer(record);
      record.deliveryUnknown = false;
      record.revokedAttachmentEpoch = null;
    }
  }

  private requireSession(
    sessionId: string,
    retry: TerminalRetryClass = "NEW_SESSION",
  ): RuntimeSession {
    const record = this.sessions.get(sessionId);
    if (!record) throw this.error("SESSION_NOT_FOUND", retry);
    return record;
  }

  private requireRunningSession(
    sessionId: string,
    retry: TerminalRetryClass = "NEW_SESSION",
  ): RuntimeSession {
    const record = this.requireSession(sessionId, retry);
    if (record.state !== "running") throw this.error("SESSION_NOT_RUNNING", retry);
    return record;
  }

  private requireGeneration(record: RuntimeSession, hostGeneration: string): void {
    const parsed = u64.safeParse(hostGeneration);
    if (!parsed.success || parsed.data !== record.hostGeneration) {
      throw this.error("STALE_HOST_GENERATION", "REATTACH");
    }
  }

  private requireAttachment(
    record: RuntimeSession,
    attachmentEpoch: string,
    retry: TerminalRetryClass,
  ): AttachmentLease {
    const parsed = u64.safeParse(attachmentEpoch);
    if (
      parsed.success &&
      record.revokedAttachmentEpoch?.toString() === parsed.data &&
      record.deliveryUnknown
    ) {
      throw this.error("INPUT_DELIVERY_UNKNOWN", "UNKNOWN_DELIVERY");
    }
    if (!parsed.success || record.attachment?.epoch.toString() !== parsed.data) {
      throw this.error("STALE_ATTACHMENT", retry);
    }
    return record.attachment;
  }

  private snapshot(record: RuntimeSession): TerminalSessionSnapshot {
    return Object.freeze(TerminalSessionSnapshotSchema().parse({
      contractVersion: 1,
      sessionId: record.sessionId,
      scope: record.scope,
      state: record.state,
      hostGeneration: record.hostGeneration,
      launch: record.launch,
      createdAt: record.createdAt,
      lastCommandSeq: record.appliedCommandSeq.toString(),
      lastOutputSeq: record.receivedOutputSeq.toString(),
      exit: record.exit,
      tombstone: record.state === "exited" || record.state === "failed",
    }));
  }

  private error(code: TerminalErrorCode, retry: TerminalRetryClass): TerminalSessionRuntimeError {
    return new TerminalSessionRuntimeError(code, retry, this.createCorrelationId);
  }

  private protocolError(): TerminalSessionRuntimeError {
    return this.error("PROTOCOL_MISMATCH", "RESTART");
  }

  private startInputStallTimer(record: RuntimeSession): void {
    if (record.inputStallTimer) return;
    record.inputStallTimer = setTimeout(() => {
      record.inputStallTimer = null;
      if (record.unacknowledgedInputBytes === 0 || !record.attachment) return;
      record.deliveryUnknown = true;
      record.revokedAttachmentEpoch = record.attachment.epoch;
      record.attachment = null;
    }, INPUT_ACKNOWLEDGEMENT_TIMEOUT_MS);
  }

  private clearInputStallTimer(record: RuntimeSession): void {
    if (!record.inputStallTimer) return;
    clearTimeout(record.inputStallTimer);
    record.inputStallTimer = null;
  }

  private clearExitFlushTimer(record: RuntimeSession): void {
    if (!record.exitFlushTimer) return;
    clearTimeout(record.exitFlushTimer);
    record.exitFlushTimer = null;
  }

  private mapHostError(
    error: unknown,
    fallbackCode: TerminalErrorCode,
    fallbackRetry: TerminalRetryClass,
  ): TerminalSessionRuntimeError {
    const message = error instanceof Error ? error.message : "";
    if (/CONTAINMENT_FAILED/.test(message)) {
      return this.error("CONTAINMENT_FAILED", "NEW_SESSION");
    }
    if (/PROTOCOL_MISMATCH/.test(message)) {
      return this.error("PROTOCOL_MISMATCH", "RESTART");
    }
    if (/stale/i.test(message) && /generation/i.test(message)) {
      return this.error("STALE_HOST_GENERATION", "REATTACH");
    }
    return this.error(fallbackCode, fallbackRetry);
  }
}

function parseSequence(
  value: string,
  protocolError: () => TerminalSessionRuntimeError,
): bigint {
  const parsed = u64.safeParse(value);
  if (!parsed.success) throw protocolError();
  return BigInt(parsed.data);
}

function parseContract<T>(
  schema: ZodType<T>,
  value: unknown,
  protocolError: () => TerminalSessionRuntimeError,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}

function validateDimensions(
  value: { readonly cols: number; readonly rows: number },
  protocolError: () => TerminalSessionRuntimeError,
): void {
  if (
    !Number.isInteger(value.cols) ||
    value.cols < 1 ||
    value.cols > TERMINAL_MAX_COLS ||
    !Number.isInteger(value.rows) ||
    value.rows < 1 ||
    value.rows > TERMINAL_MAX_ROWS
  ) {
    throw protocolError();
  }
}

function freezeScope(scope: TerminalScope): TerminalScope {
  return Object.freeze({ ...scope });
}

function freezeLaunch(launch: TerminalLaunchSnapshot): TerminalLaunchSnapshot {
  return Object.freeze({
    ...launch,
    resolvedProfile: Object.freeze({
      ...launch.resolvedProfile,
      arguments: Object.freeze([...launch.resolvedProfile.arguments]),
    }),
    scope: freezeScope(launch.scope),
    arguments: Object.freeze([...launch.arguments]),
  }) as TerminalLaunchSnapshot;
}
