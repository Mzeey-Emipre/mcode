import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { TerminalPlatform } from "@mcode/contracts";
import {
  PTY_HOST_MAX_DATA_BYTES,
  PTY_HOST_HEARTBEAT_INTERVAL_MS,
  parsePtyHostServerMessage,
  PtyHostServerMessageSchema,
  type PtyHostEvent,
  type PtyHostServerMessage,
} from "./pty-host-protocol.js";
import { createPtyProcessScope } from "./pty-process-scope.js";

const nativeRequire = createRequire(import.meta.url);
const MAX_SESSIONS = 20;

/** Containment operations owned by one PTY host session. */
export interface PtyProcessScope {
  readonly mechanism: "job-object" | "process-group";
  readonly processGroupId: string;
  establish(): Promise<boolean>;
  hasChildren(): Promise<boolean>;
  close(): Promise<void>;
  dispose(): void;
}

/** Construction options for the isolated PTY host runtime. */
export interface PtyHostProcessRuntimeOptions {
  readonly platform: TerminalPlatform;
  readonly nativeAbi: string;
  readonly publish: (event: PtyHostEvent) => void;
  readonly queueBytes?: () => number;
  readonly spawnPty?: typeof import("node-pty").spawn;
  readonly createScope?: (rootPid: number) => PtyProcessScope;
}

interface HostSession {
  readonly pty: IPty;
  readonly scope: PtyProcessScope;
  readonly dataDisposable: { dispose(): void };
  readonly exitDisposable: { dispose(): void };
  commandSeq: bigint;
  outputSeq: bigint;
  closeReason:
    | "natural"
    | "user-close"
    | "host-crash"
    | "containment-failure"
    | "protocol-failure";
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

/** Runs native PTYs behind the strict version 1 private host protocol. */
export class PtyHostProcessRuntime {
  private readonly sessions = new Map<string, HostSession>();
  private generation: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly options: PtyHostProcessRuntimeOptions) {}

  /** Validates and applies one server message. */
  async receive(value: unknown): Promise<void> {
    if (this.disposed) throw new Error("PTY host runtime is stopped");
    const message =
      this.generation === null
        ? PtyHostServerMessageSchema().parse(value)
        : parsePtyHostServerMessage(value, this.generation);
    if (this.generation === null) {
      if (message.kind !== "handshake")
        throw new Error("PTY host handshake is required");
      this.acceptHandshake(message);
      return;
    }
    switch (message.kind) {
      case "handshake":
        throw new Error("PTY host handshake is already complete");
      case "create":
        await this.create(message);
        return;
      case "command.input":
      case "command.resize":
        this.applyCommand(message);
        return;
      case "inspectChildren":
        this.options.publish({
          contractVersion: 1,
          kind: "children",
          sessionId: message.sessionId,
          hostGeneration: message.hostGeneration,
          hasChildren: await this.requireSession(
            message.sessionId,
          ).scope.hasChildren(),
        });
        return;
      case "close":
        await this.closeSession(
          message.sessionId,
          "user-close",
          message.closeSeq,
        );
        return;
      case "probe":
        this.publishHeartbeat();
        return;
      case "shutdown":
        await Promise.all(
          [...this.sessions.keys()].map((sessionId) =>
            this.closeSession(sessionId, "user-close"),
          ),
        );
        await this.dispose();
    }
  }

  /** Stops heartbeat publication and force-releases remaining native handles. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const session of this.sessions.values()) {
      session.dataDisposable.dispose();
      session.exitDisposable.dispose();
      session.scope.dispose();
      session.resolveExit();
    }
    this.sessions.clear();
  }

  private acceptHandshake(
    message: Extract<PtyHostServerMessage, { kind: "handshake" }>,
  ): void {
    if (message.platform !== this.options.platform)
      throw new Error("PTY host platform mismatch");
    this.generation = message.requestedGeneration;
    this.options.publish({
      contractVersion: 1,
      kind: "ready",
      hostGeneration: message.requestedGeneration,
      platform: this.options.platform,
      nativeAbi: this.options.nativeAbi,
      capabilities: {
        pty: this.options.platform === "windows" ? "conpty" : "posix-pty",
        containment:
          this.options.platform === "windows" ? "job-object" : "process-group",
        maxSessions: 20,
        protocolVersion: 1,
      },
    });
    this.heartbeatTimer = setInterval(
      () => this.publishHeartbeat(),
      PTY_HOST_HEARTBEAT_INTERVAL_MS,
    );
  }

  private async create(
    message: Extract<PtyHostServerMessage, { kind: "create" }>,
  ): Promise<void> {
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error("PTY host session limit reached");
    if (this.sessions.has(message.sessionId))
      throw new Error(`PTY session already exists: ${message.sessionId}`);
    const spawnPty = this.options.spawnPty ?? this.loadNativeSpawn();
    const pty = spawnPty(message.executable, [...message.arguments], {
      name: "xterm-256color",
      cols: message.cols,
      rows: message.rows,
      cwd: message.cwd,
      env: Object.fromEntries(
        message.env.map(({ name, value }) => [name, value]),
      ),
      encoding: null,
      ...(this.options.platform === "windows"
        ? { useConpty: true, useConptyDll: true }
        : {}),
    });
    pty.pause();
    const scope = (this.options.createScope ?? createPtyProcessScope)(pty.pid);
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: HostSession = {
      pty,
      scope,
      commandSeq: 0n,
      outputSeq: 0n,
      closeReason: "natural",
      exitPromise,
      resolveExit,
      dataDisposable: { dispose: () => undefined },
      exitDisposable: { dispose: () => undefined },
    };
    const dataDisposable = pty.onData((data) =>
      this.publishOutput(message.sessionId, data),
    );
    const exitDisposable = pty.onExit(({ exitCode, signal }) => {
      this.handleExit(message.sessionId, exitCode, signal ?? null);
    });
    Object.assign(session, { dataDisposable, exitDisposable });

    try {
      const established = await scope.establish();
      this.options.publish({
        contractVersion: 1,
        kind: "containment",
        sessionId: message.sessionId,
        hostGeneration: message.hostGeneration,
        established,
        mechanism: scope.mechanism,
        processGroupId: scope.processGroupId,
      });
      if (!established) {
        session.closeReason = "containment-failure";
        dataDisposable.dispose();
        exitDisposable.dispose();
        await this.terminateUnstartedPty(pty, scope);
        this.options.publish({
          contractVersion: 1,
          kind: "failure",
          hostGeneration: message.hostGeneration,
          boundary: "containment",
          recoverable: false,
          code: "CONTAINMENT_FAILED",
        });
        return;
      }
      this.sessions.set(message.sessionId, session);
      this.options.publish({
        contractVersion: 1,
        kind: "running",
        sessionId: message.sessionId,
        hostGeneration: message.hostGeneration,
        rootPid: pty.pid,
        processGroupId: scope.processGroupId,
        containment: scope.mechanism,
      });
      pty.resume();
    } catch (error) {
      this.sessions.delete(message.sessionId);
      dataDisposable.dispose();
      exitDisposable.dispose();
      await this.terminateUnstartedPty(pty, scope);
      throw error;
    }
  }

  private applyCommand(
    message: Extract<
      PtyHostServerMessage,
      { kind: "command.input" | "command.resize" }
    >,
  ): void {
    const session = this.requireSession(message.sessionId);
    const sequence = BigInt(message.commandSeq);
    if (sequence !== session.commandSeq + 1n)
      throw new Error("PTY command sequence is out of order");
    if (message.kind === "command.input") {
      session.pty.write(Buffer.from(message.dataBase64, "base64"));
    } else {
      session.pty.resize(message.cols, message.rows);
    }
    session.commandSeq = sequence;
    this.options.publish({
      contractVersion: 1,
      kind: "commandAck",
      sessionId: message.sessionId,
      hostGeneration: message.hostGeneration,
      attachmentEpoch: message.attachmentEpoch,
      appliedCommandSeq: message.commandSeq,
      appliedOutputSeq: session.outputSeq.toString(),
    });
  }

  private publishOutput(sessionId: string, data: string | Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    for (
      let offset = 0;
      offset < bytes.length;
      offset += PTY_HOST_MAX_DATA_BYTES
    ) {
      const chunk = bytes.subarray(offset, offset + PTY_HOST_MAX_DATA_BYTES);
      if (chunk.length === 0) continue;
      session.outputSeq += 1n;
      this.options.publish({
        contractVersion: 1,
        kind: "output",
        sessionId,
        hostGeneration: this.requireGeneration(),
        outputSeq: session.outputSeq.toString(),
        dataBase64: chunk.toString("base64"),
      });
    }
  }

  private async closeSession(
    sessionId: string,
    reason: HostSession["closeReason"],
    closeSeq?: string,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if (
      closeSeq !== undefined &&
      BigInt(closeSeq) !== session.commandSeq + 1n
    ) {
      throw new Error("PTY close sequence is out of order");
    }
    session.closeReason = reason;
    await session.scope.close();
    await session.exitPromise;
  }

  private handleExit(
    sessionId: string,
    code: number,
    signal: number | null,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.dataDisposable.dispose();
    session.exitDisposable.dispose();
    session.scope.dispose();
    this.sessions.delete(sessionId);
    this.options.publish({
      contractVersion: 1,
      kind: "exit",
      sessionId,
      hostGeneration: this.requireGeneration(),
      finalOutputSeq: session.outputSeq.toString(),
      code,
      signal,
      reason: session.closeReason,
    });
    session.resolveExit();
  }

  private publishHeartbeat(): void {
    this.options.publish({
      contractVersion: 1,
      kind: "heartbeat",
      hostGeneration: this.requireGeneration(),
      monotonicMs: Math.floor(performance.now()).toString(),
      activeSessions: this.sessions.size,
      queueBytes: this.options.queueBytes?.() ?? 0,
      rssBytes: process.memoryUsage().rss.toString(),
    });
  }

  private requireSession(sessionId: string): HostSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`PTY session not found: ${sessionId}`);
    return session;
  }

  private async terminateUnstartedPty(
    pty: IPty,
    scope: PtyProcessScope,
  ): Promise<void> {
    try {
      await scope.close();
    } catch {
      pty.kill();
    } finally {
      scope.dispose();
    }
  }

  private requireGeneration(): string {
    if (this.generation === null)
      throw new Error("PTY host handshake is incomplete");
    return this.generation;
  }

  private loadNativeSpawn(): typeof import("node-pty").spawn {
    return (nativeRequire("node-pty") as typeof import("node-pty")).spawn;
  }
}
