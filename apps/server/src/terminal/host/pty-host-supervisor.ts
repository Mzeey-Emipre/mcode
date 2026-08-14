import type { TerminalPlatform } from "@mcode/contracts";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "../../services/process-kill.js";
import {
  type PtyHostCleanupLedgerStore,
  type PtyHostCleanupRecord,
} from "../cleanup/terminal-cleanup-ledger.js";
import { reapPtyHostCleanupRecords } from "../cleanup/reap-orphaned-terminals.js";
import type {
  PtyHostAdapter,
  PtyHostClose,
  PtyHostCommand,
  PtyHostCreate,
  PtyHostDiagnostics,
  PtyHostHealth,
  PtyHostRunning,
} from "./pty-host-adapter.js";
import {
  parsePtyHostEvent,
  PtyHostServerMessageSchema,
  type PtyHostEvent,
  type PtyHostServerMessage,
} from "./pty-host-protocol.js";
import { reapPosixProcessSession } from "./posix-process-scope.js";

const STARTUP_TIMEOUT_MS = 5_000;
const REPLACEMENT_DELAY_MS = 250;
const HEARTBEAT_DEGRADED_MS = 750;
const HEARTBEAT_UNHEALTHY_MS = 1_000;
const OPERATION_TIMEOUT_MS = 5_000;
const MAX_IPC_QUEUE_BYTES = 1_048_576;
const CONTAINMENT_SETTLE_TIMEOUT_MS = 500;

/** Minimal child-process surface used by the PTY host supervisor. */
export interface PtyHostChild {
  readonly pid?: number;
  readonly connected: boolean;
  send(
    message: PtyHostServerMessage,
    callback?: (error: Error | null) => void,
  ): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  disposeContainment?(): void;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  removeAllListeners(): this;
}

/** Construction options for a supervised PTY host. */
export interface PtyHostSupervisorOptions {
  readonly platform: TerminalPlatform;
  readonly spawnHost: () => PtyHostChild;
  readonly startupTimeoutMs?: number;
  readonly replacementDelayMs?: number;
  readonly heartbeatDegradedMs?: number;
  readonly heartbeatUnhealthyMs?: number;
  readonly cleanupLedger: PtyHostCleanupLedgerStore;
  readonly reapProcessTree?: (record: PtyHostCleanupRecord) => Promise<void>;
  readonly operationTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

type SupervisorState =
  "stopped" | "starting" | "healthy" | "degraded" | "unhealthy";

interface PendingCreate {
  readonly resolve: (running: PtyHostRunning) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingClose {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingInspection {
  readonly promise: Promise<{ hasChildren: boolean }>;
  readonly resolve: (result: { hasChildren: boolean }) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Supervises one versioned PTY host and permits one bounded replacement. */
export class PtyHostSupervisor implements PtyHostAdapter {
  private child: PtyHostChild | null = null;
  private generation = 0n;
  private state: SupervisorState = "stopped";
  private readyObserved = false;
  private heartbeatObserved = false;
  private lastHeartbeatAtMs: number | null = null;
  private lastHeartbeatReceivedAtMs: number | null = null;
  private heartbeatQueueBytes = 0;
  private heartbeatRssBytes = "0";
  private heartbeatEventLoopLagMs = 0;
  private replacementUsed = false;
  private stopping = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private outboundBytes = 0;
  private startPromise: Promise<PtyHostHealth> | null = null;
  private resolveStart: ((health: PtyHostHealth) => void) | null = null;
  private rejectStart: ((error: Error) => void) | null = null;
  private readonly listeners = new Set<(event: PtyHostEvent) => void>();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  private readonly pendingCloses = new Map<string, PendingClose>();
  private readonly pendingInspections = new Map<string, PendingInspection>();
  private readonly cleanupLedger: PtyHostCleanupLedgerStore;

  constructor(private readonly options: PtyHostSupervisorOptions) {
    const degradedMs = options.heartbeatDegradedMs ?? HEARTBEAT_DEGRADED_MS;
    const unhealthyMs = options.heartbeatUnhealthyMs ?? HEARTBEAT_UNHEALTHY_MS;
    if (degradedMs < 1 || unhealthyMs <= degradedMs) {
      throw new Error("PTY host heartbeat bounds are invalid");
    }
    this.cleanupLedger = options.cleanupLedger;
  }

  /** Starts the initial PTY host generation. */
  start(): Promise<PtyHostHealth> {
    if (this.startPromise) return this.startPromise;
    if (this.state !== "stopped")
      throw new Error("PTY host is already started");
    this.state = "starting";
    this.startPromise = this.startAfterOrphanRecovery();
    return this.startPromise;
  }

  /** Returns the current externally visible host health. */
  health(): PtyHostHealth {
    return {
      hostGeneration: this.generation.toString(),
      state: this.state,
    };
  }

  /** Returns the latest content-free host measurements for diagnostics. */
  diagnostics(): PtyHostDiagnostics {
    return {
      lastHeartbeatMsAgo: this.lastHeartbeatAtMs === null
        ? null
        : Math.min(60_000, Math.max(0, Date.now() - this.lastHeartbeatAtMs)),
      queueBytes: this.heartbeatQueueBytes,
      eventLoopLagMs: this.heartbeatEventLoopLagMs,
      hostRssBytes: this.heartbeatRssBytes,
    };
  }

  /** Resolves when the active generation becomes healthy. */
  whenHealthy(): Promise<PtyHostHealth> {
    if (this.state === "healthy") return Promise.resolve(this.health());
    if (this.startPromise) return this.startPromise;
    return Promise.reject(new Error("PTY host is not started"));
  }

  /** Creates one PTY after host health is established. */
  async create(input: PtyHostCreate): Promise<PtyHostRunning> {
    this.requireHealthyGeneration(input.hostGeneration);
    if (this.pendingCreates.has(input.sessionId)) {
      throw new Error(
        `PTY session create is already pending: ${input.sessionId}`,
      );
    }
    const result = new Promise<PtyHostRunning>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreates.delete(input.sessionId);
        reject(new Error(`PTY create exceeded ${this.operationTimeoutMs()}ms`));
      }, this.operationTimeoutMs());
      this.pendingCreates.set(input.sessionId, { resolve, reject, timer });
    });
    try {
      this.sendMessage({
        contractVersion: 1,
        kind: "create",
        sessionId: input.sessionId,
        hostGeneration: input.hostGeneration,
        scope: input.launch.scope,
        executable: input.launch.resolvedProfile.executable,
        arguments: [...input.launch.arguments],
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        env: [...input.protectedEnv],
      });
    } catch (error) {
      const pending = this.pendingCreates.get(input.sessionId);
      if (pending) clearTimeout(pending.timer);
      this.pendingCreates.delete(input.sessionId);
      throw error;
    }
    return result;
  }

  /** Sends one ordered input or resize command to the healthy host. */
  async send(command: PtyHostCommand): Promise<void> {
    this.requireHealthyGeneration(command.hostGeneration);
    this.sendMessage(
      command.kind === "input"
        ? {
            contractVersion: 1,
            kind: "command.input",
            sessionId: command.sessionId,
            hostGeneration: command.hostGeneration,
            attachmentEpoch: command.attachmentEpoch,
            commandSeq: command.commandSeq,
            dataBase64: Buffer.from(command.data).toString("base64"),
          }
        : {
            contractVersion: 1,
            kind: "command.resize",
            sessionId: command.sessionId,
            hostGeneration: command.hostGeneration,
            attachmentEpoch: command.attachmentEpoch,
            commandSeq: command.commandSeq,
            cols: command.data.cols,
            rows: command.data.rows,
          },
    );
  }

  /** Requests child inspection for one generation-bound PTY session. */
  async inspectChildren(
    sessionId: string,
    hostGeneration: string,
  ): Promise<{ hasChildren: boolean }> {
    this.requireHealthyGeneration(hostGeneration);
    const record = this.cleanupLedger.get(sessionId);
    if (!record || record.hostGeneration !== hostGeneration) {
      throw new Error(`PTY session not found: ${sessionId}`);
    }
    const existing = this.pendingInspections.get(sessionId);
    if (existing) return existing.promise;
    let resolveInspection!: (result: { hasChildren: boolean }) => void;
    let rejectInspection!: (error: Error) => void;
    const promise = new Promise<{ hasChildren: boolean }>((resolve, reject) => {
      resolveInspection = resolve;
      rejectInspection = reject;
    });
    const timer = setTimeout(() => {
      this.pendingInspections.delete(sessionId);
      rejectInspection(
        new Error(
          `PTY child inspection exceeded ${this.operationTimeoutMs()}ms`,
        ),
      );
    }, this.operationTimeoutMs());
    this.pendingInspections.set(sessionId, {
      promise,
      resolve: resolveInspection,
      reject: rejectInspection,
      timer,
    });
    try {
      this.sendMessage({
        contractVersion: 1,
        kind: "inspectChildren",
        sessionId,
        hostGeneration,
      });
    } catch (error) {
      clearTimeout(timer);
      this.pendingInspections.delete(sessionId);
      throw error;
    }
    return promise;
  }

  /** Sends one ordered close barrier. */
  async close(input: PtyHostClose): Promise<void> {
    this.requireHealthyGeneration(input.hostGeneration);
    const existing = this.pendingCloses.get(input.sessionId);
    if (existing) return existing.promise;
    let resolveClose!: () => void;
    let rejectClose!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    const timer = setTimeout(() => {
      this.pendingCloses.delete(input.sessionId);
      rejectClose(
        new Error(`PTY close exceeded ${this.operationTimeoutMs()}ms`),
      );
    }, this.operationTimeoutMs());
    this.pendingCloses.set(input.sessionId, {
      promise,
      resolve: resolveClose,
      reject: rejectClose,
      timer,
    });
    try {
      this.sendMessage({ contractVersion: 1, kind: "close", ...input });
    } catch (error) {
      clearTimeout(timer);
      this.pendingCloses.delete(input.sessionId);
      throw error;
    }
    return promise;
  }

  /** Stops the active host without starting a replacement. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.clearStartupTimer();
    this.clearHeartbeatTimer();
    const child = this.child;
    if (child?.connected && this.generation > 0n) {
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      child.once("exit", resolveExit);
      try {
        this.sendMessage({
          contractVersion: 1,
          kind: "shutdown",
          hostGeneration: this.generation.toString(),
          reason: "app-shutdown",
        });
      } catch {
        child.kill("SIGKILL");
      }
      const timeout = setTimeout(
        resolveExit,
        this.options.shutdownTimeoutMs ?? OPERATION_TIMEOUT_MS,
      );
      await exited;
      clearTimeout(timeout);
      if (child.connected) child.kill("SIGKILL");
    }
    child?.disposeContainment?.();
    child?.removeAllListeners();
    this.child = null;
    this.lastHeartbeatAtMs = null;
    this.lastHeartbeatReceivedAtMs = null;
    this.heartbeatQueueBytes = 0;
    this.heartbeatRssBytes = "0";
    this.heartbeatEventLoopLagMs = 0;
    this.state = "stopped";
    this.startPromise = null;
    this.resolveStart = null;
    this.rejectStart = null;
    this.rejectPending(new Error("PTY host stopped"));
    const failures = await this.reapCleanupRecords(this.cleanupLedger.list());
    if (failures.length > 0) {
      throw new AggregateError(failures, "PTY host shutdown cleanup failed");
    }
  }

  /** Subscribes to validated events from every supervised generation. */
  subscribe(listener: (event: PtyHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private spawnGeneration(): Promise<PtyHostHealth> {
    this.generation += 1n;
    this.state = "starting";
    this.readyObserved = false;
    this.heartbeatObserved = false;
    const generation = this.generation.toString();
    const child = this.options.spawnHost();
    this.child = child;
    child.on("message", (message) =>
      this.handleMessage(child, generation, message),
    );
    child.on("error", (error) => this.handleHostFailure(child, error));
    child.on("exit", () =>
      this.handleHostFailure(child, new Error("PTY host process exited")),
    );

    const promise = new Promise<PtyHostHealth>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.startupTimer = setTimeout(() => {
      this.handleHostFailure(
        child,
        new Error(
          `PTY host startup exceeded ${this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS}ms`,
        ),
      );
    }, this.options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
    try {
      this.sendMessage({
        contractVersion: 1,
        kind: "handshake",
        requestedGeneration: generation,
        platform: this.options.platform,
      });
    } catch (error) {
      this.handleHostFailure(
        child,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return promise;
  }

  private handleMessage(
    child: PtyHostChild,
    generation: string,
    value: unknown,
  ): void {
    if (child !== this.child) return;
    let event: PtyHostEvent;
    try {
      event = parsePtyHostEvent(value, generation);
    } catch (error) {
      this.handleHostFailure(
        child,
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }
    if (event.kind === "ready") this.readyObserved = true;
    if (event.kind === "heartbeat") {
      this.heartbeatObserved = true;
      const receivedAtMs = Date.now();
      this.heartbeatEventLoopLagMs = this.lastHeartbeatReceivedAtMs === null
        ? 0
        : Math.max(0, receivedAtMs - this.lastHeartbeatReceivedAtMs - HEARTBEAT_INTERVAL_MS);
      this.lastHeartbeatReceivedAtMs = receivedAtMs;
      this.lastHeartbeatAtMs = receivedAtMs;
      this.heartbeatQueueBytes = event.queueBytes;
      this.heartbeatRssBytes = event.rssBytes;
      if (this.state === "degraded") this.state = "healthy";
      this.armHeartbeatWatchdog(child, generation);
    }
    if (event.kind === "running") {
      try {
        this.cleanupLedger.record({
          sessionId: event.sessionId,
          hostGeneration: event.hostGeneration,
          rootPid: event.rootPid,
          processGroupId: event.processGroupId,
          containment: event.containment,
        });
      } catch (error) {
        this.handleHostFailure(
          child,
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      this.pendingCreates.get(event.sessionId)?.resolve({
        sessionId: event.sessionId,
        hostGeneration: event.hostGeneration,
        state: "running",
        containment: event.containment,
      });
      const pending = this.pendingCreates.get(event.sessionId);
      if (pending) clearTimeout(pending.timer);
      this.pendingCreates.delete(event.sessionId);
    }
    if (event.kind === "exit") {
      this.cleanupLedger.remove(event.sessionId, event.hostGeneration);
      const pendingInspection = this.pendingInspections.get(event.sessionId);
      if (pendingInspection) {
        clearTimeout(pendingInspection.timer);
        pendingInspection.reject(
          new Error(
            `PTY session exited during child inspection: ${event.sessionId}`,
          ),
        );
        this.pendingInspections.delete(event.sessionId);
      }
      const pending = this.pendingCloses.get(event.sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve();
        this.pendingCloses.delete(event.sessionId);
      }
    }
    if (event.kind === "children") {
      const pending = this.pendingInspections.get(event.sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve({ hasChildren: event.hasChildren });
        this.pendingInspections.delete(event.sessionId);
      }
    }
    if (event.kind === "failure") this.rejectPending(new Error(event.code));
    this.publish(event);
    if (
      this.readyObserved &&
      this.heartbeatObserved &&
      this.state === "starting"
    ) {
      this.state = "healthy";
      this.clearStartupTimer();
      const health = this.health();
      this.resolveStart?.(health);
      this.resolveStart = null;
      this.rejectStart = null;
    }
  }

  private handleHostFailure(child: PtyHostChild, error: Error): void {
    if (child !== this.child || this.stopping) return;
    const canReplace = this.state === "healthy" || this.state === "degraded";
    child.removeAllListeners();
    child.kill("SIGKILL");
    child.disposeContainment?.();
    this.child = null;
    this.outboundBytes = 0;
    this.lastHeartbeatAtMs = null;
    this.lastHeartbeatReceivedAtMs = null;
    this.heartbeatQueueBytes = 0;
    this.heartbeatRssBytes = "0";
    this.heartbeatEventLoopLagMs = 0;
    this.clearStartupTimer();
    this.clearHeartbeatTimer();
    this.rejectStart?.(error);
    this.rejectStart = null;
    this.resolveStart = null;
    this.startPromise = null;
    this.state = "unhealthy";
    this.publish({
      contractVersion: 1,
      kind: "failure",
      hostGeneration: this.generation.toString(),
      boundary: "shutdown",
      recoverable: canReplace && !this.replacementUsed,
      code: "HOST_UNHEALTHY",
    });
    this.rejectPending(error);
    if (!canReplace || this.replacementUsed) return;
    this.replacementUsed = true;
    const failedGeneration = this.generation.toString();
    const records = this.cleanupLedger.forGeneration(failedGeneration);
    setTimeout(async () => {
      if (this.stopping || this.child) return;
      const failures = await this.reapCleanupRecords(records);
      if (failures.length > 0) {
        this.publish({
          contractVersion: 1,
          kind: "failure",
          hostGeneration: failedGeneration,
          boundary: "shutdown",
          recoverable: false,
          code: "HOST_UNHEALTHY",
        });
        return;
      }
      this.startPromise = this.spawnGeneration();
      void this.startPromise.catch(() => undefined);
    }, this.options.replacementDelayMs ?? REPLACEMENT_DELAY_MS);
  }

  private sendMessage(value: PtyHostServerMessage): void {
    const child = this.child;
    if (!child?.connected) throw new Error("PTY host channel is unavailable");
    const message = PtyHostServerMessageSchema().parse(value);
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (this.outboundBytes + messageBytes > MAX_IPC_QUEUE_BYTES) {
      throw new Error("PTY host channel queue exceeds 1 MiB");
    }
    this.outboundBytes += messageBytes;
    try {
      child.send(message, (error) => {
        this.outboundBytes = Math.max(0, this.outboundBytes - messageBytes);
        if (error) this.handleHostFailure(child, error);
      });
    } catch (error) {
      this.outboundBytes = Math.max(0, this.outboundBytes - messageBytes);
      throw error;
    }
  }

  private requireHealthyGeneration(hostGeneration: string): void {
    if (this.state !== "healthy") throw new Error("PTY host is unhealthy");
    if (hostGeneration !== this.generation.toString())
      throw new Error("PTY host generation is stale");
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingCreates.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCreates.clear();
    for (const pending of this.pendingCloses.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCloses.clear();
    for (const pending of this.pendingInspections.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingInspections.clear();
  }

  private operationTimeoutMs(): number {
    return this.options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  }

  private async reapProcessTree(
    record: PtyHostCleanupRecord,
  ): Promise<void> {
    if (this.options.platform !== "windows") {
      if (record.containment !== "process-group") {
        throw new Error("POSIX PTY cleanup record has invalid containment");
      }
      await reapPosixProcessSession(
        record.rootPid,
        record.processGroupId,
      );
      return;
    }
    if (
      record.containment !== "job-object" ||
      record.processGroupId !== `job-${record.rootPid}`
    ) {
      throw new Error("Windows PTY cleanup record has invalid containment");
    }
    const deadline = Date.now() + CONTAINMENT_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(record.rootPid)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.isProcessAlive(record.rootPid)) {
      await killProcessTree(record.rootPid);
    }
  }

  private async startAfterOrphanRecovery(): Promise<PtyHostHealth> {
    const records = this.cleanupLedger.list();
    const failures = await this.reapCleanupRecords(records);
    if (failures.length > 0) {
      this.state = "unhealthy";
      throw new AggregateError(
        failures,
        "PTY host startup orphan cleanup failed",
      );
    }
    if (this.stopping) {
      this.state = "stopped";
      throw new Error("PTY host stopped during startup cleanup");
    }
    return this.spawnGeneration();
  }

  private reapCleanupRecords(
    records: readonly PtyHostCleanupRecord[],
  ): Promise<unknown[]> {
    const reap =
      this.options.reapProcessTree ??
      ((record: PtyHostCleanupRecord) => this.reapProcessTree(record));
    return reapPtyHostCleanupRecords(
      this.cleanupLedger,
      records,
      reap,
    );
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private armHeartbeatWatchdog(child: PtyHostChild, generation: string): void {
    this.clearHeartbeatTimer();
    const degradedMs =
      this.options.heartbeatDegradedMs ?? HEARTBEAT_DEGRADED_MS;
    const unhealthyMs =
      this.options.heartbeatUnhealthyMs ?? HEARTBEAT_UNHEALTHY_MS;
    this.heartbeatTimer = setTimeout(() => {
      if (child !== this.child || this.state !== "healthy") return;
      this.state = "degraded";
      try {
        this.sendMessage({
          contractVersion: 1,
          kind: "probe",
          hostGeneration: generation,
          nonce: randomUUID(),
        });
      } catch (error) {
        this.handleHostFailure(
          child,
          error instanceof Error ? error : new Error(String(error)),
        );
        return;
      }
      this.heartbeatTimer = setTimeout(() => {
        if (child !== this.child || this.state !== "degraded") return;
        this.handleHostFailure(
          child,
          new Error(`PTY host heartbeat exceeded ${HEARTBEAT_UNHEALTHY_MS}ms`),
        );
      }, unhealthyMs - degradedMs);
    }, degradedMs);
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) return;
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private publish(event: PtyHostEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
