import * as NodeBuffer from "node:buffer";
import { TerminalU64Schema, type TerminalPlatform } from "@mcode/contracts";
import type {
  PtyHostAdapter,
  PtyHostClose,
  PtyHostCommand,
  PtyHostCreate,
  PtyHostHealth,
  PtyHostRunning,
} from "../host/pty-host-adapter.js";
import {
  InMemoryPtyHostProtocol,
  type PtyHostEvent,
} from "../host/pty-host-protocol.js";

interface InMemorySession {
  readonly containment: "job-object" | "process-group";
  outputSeq: bigint;
  commandSeq: bigint;
  hasChildren: boolean;
}

const u64 = TerminalU64Schema();

/** Deterministic PTY host adapter for later session-runtime tests. */
export class InMemoryPtyHostAdapter implements PtyHostAdapter {
  private readonly protocol: InMemoryPtyHostProtocol;
  private readonly sessions = new Map<string, InMemorySession>();
  private readonly listeners = new Set<(event: PtyHostEvent) => void>();
  private started = false;

  constructor(
    private readonly hostGeneration: string,
    private readonly platform: TerminalPlatform = "windows",
  ) {
    this.protocol = new InMemoryPtyHostProtocol(hostGeneration);
  }

  /** Starts the deterministic host generation. */
  async start(): Promise<PtyHostHealth> {
    if (this.started) throw new Error("PTY host is already started");
    this.protocol.sendToHost({
      contractVersion: 1,
      kind: "handshake",
      requestedGeneration: this.hostGeneration,
      platform: this.platform,
    });
    this.started = true;
    this.publish({
      contractVersion: 1,
      kind: "ready",
      hostGeneration: this.hostGeneration,
      platform: this.platform,
      nativeAbi: "in-memory-v1",
      capabilities: {
        pty: this.platform === "windows" ? "conpty" : "posix-pty",
        containment: this.platform === "windows" ? "job-object" : "process-group",
        maxSessions: 20,
        protocolVersion: 1,
      },
    });
    return { hostGeneration: this.hostGeneration, state: "healthy" };
  }

  /** Creates one deterministic contained PTY session. */
  async create(input: PtyHostCreate): Promise<PtyHostRunning> {
    this.requireStarted();
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`PTY session already exists: ${input.sessionId}`);
    }
    const containment = this.platform === "windows" ? "job-object" : "process-group";
    this.protocol.sendToHost({
      contractVersion: 1,
      kind: "create",
      sessionId: input.sessionId,
      hostGeneration: input.hostGeneration,
      scope: input.launch.scope,
      executable: input.launch.resolvedProfile.executable,
      arguments: input.launch.arguments,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env: [...input.protectedEnv],
    });
    this.sessions.set(input.sessionId, { containment, outputSeq: 0n, commandSeq: 0n, hasChildren: false });
    const processGroupId = `memory-${input.sessionId}`;
    this.publish({
      contractVersion: 1,
      kind: "containment",
      sessionId: input.sessionId,
      hostGeneration: this.hostGeneration,
      established: true,
      mechanism: containment,
      processGroupId,
    });
    this.publish({
      contractVersion: 1,
      kind: "running",
      sessionId: input.sessionId,
      hostGeneration: this.hostGeneration,
      rootPid: 1,
      processGroupId,
      containment,
    });
    return { sessionId: input.sessionId, hostGeneration: this.hostGeneration, state: "running", containment };
  }

  /** Applies one validated command and emits its cumulative acknowledgement. */
  async send(command: PtyHostCommand): Promise<void> {
    const session = this.requireSession(command.sessionId);
    const commandSeq = u64.safeParse(command.commandSeq);
    if (!commandSeq.success) {
      throw new Error(`PTY command sequence is not a u64: ${command.commandSeq}`);
    }
    const next = session.commandSeq + 1n;
    if (BigInt(commandSeq.data) !== next) throw new Error("PTY command sequence is out of order");
    if (command.kind === "input") {
      this.protocol.sendToHost({ contractVersion: 1, kind: "command.input", sessionId: command.sessionId, hostGeneration: command.hostGeneration, attachmentEpoch: command.attachmentEpoch, commandSeq: command.commandSeq, dataBase64: NodeBuffer.Buffer.from(command.data).toString("base64") });
    } else {
      this.protocol.sendToHost({ contractVersion: 1, kind: "command.resize", sessionId: command.sessionId, hostGeneration: command.hostGeneration, attachmentEpoch: command.attachmentEpoch, commandSeq: command.commandSeq, cols: command.data.cols, rows: command.data.rows });
    }
    session.commandSeq = next;
    this.publish({ contractVersion: 1, kind: "commandAck", sessionId: command.sessionId, hostGeneration: this.hostGeneration, attachmentEpoch: command.attachmentEpoch, appliedCommandSeq: command.commandSeq, appliedOutputSeq: session.outputSeq.toString() });
  }

  /** Validates generation and returns deterministic child state. */
  async inspectChildren(sessionId: string, hostGeneration: string): Promise<{ hasChildren: boolean }> {
    const session = this.requireSession(sessionId);
    this.protocol.sendToHost({ contractVersion: 1, kind: "inspectChildren", sessionId, hostGeneration });
    return { hasChildren: session.hasChildren };
  }

  /** Applies a close barrier and emits a final exit event. */
  async close(input: PtyHostClose): Promise<void> {
    const session = this.requireSession(input.sessionId);
    this.protocol.sendToHost({ contractVersion: 1, kind: "close", ...input });
    this.publish({ contractVersion: 1, kind: "exit", sessionId: input.sessionId, hostGeneration: this.hostGeneration, finalOutputSeq: session.outputSeq.toString(), code: 0, signal: null, reason: "user-close" });
    this.sessions.delete(input.sessionId);
  }

  /** Closes the deterministic host and clears all sessions. */
  async shutdown(): Promise<void> {
    if (this.started) {
      this.protocol.sendToHost({ contractVersion: 1, kind: "shutdown", hostGeneration: this.hostGeneration, reason: "app-shutdown" });
      for (const [sessionId, session] of this.sessions) {
        this.publish({
          contractVersion: 1,
          kind: "exit",
          sessionId,
          hostGeneration: this.hostGeneration,
          finalOutputSeq: session.outputSeq.toString(),
          code: 0,
          signal: null,
          reason: "user-close",
        });
      }
    }
    this.sessions.clear();
    this.listeners.clear();
    this.started = false;
  }

  /** Subscribes to validated deterministic host events. */
  subscribe(listener: (event: PtyHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Emits one bounded output batch for a live deterministic session. */
  emitOutput(sessionId: string, data: Uint8Array): void {
    const session = this.requireSession(sessionId);
    session.outputSeq += 1n;
    this.publish({ contractVersion: 1, kind: "output", sessionId, hostGeneration: this.hostGeneration, outputSeq: session.outputSeq.toString(), dataBase64: NodeBuffer.Buffer.from(data).toString("base64") });
  }

  private publish(event: PtyHostEvent): void {
    const validated = this.protocol.receiveFromHost(event);
    for (const listener of this.listeners) listener(validated);
  }

  private requireStarted(): void {
    if (!this.started) throw new Error("PTY host is not started");
  }

  private requireSession(sessionId: string): InMemorySession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`PTY session not found: ${sessionId}`);
    return session;
  }
}
