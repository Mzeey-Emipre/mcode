import type {
  TerminalBackendCapabilities,
  TerminalErrorCode,
  TerminalProfileInUseData,
  TerminalRetryClass,
  WorkspaceEnvironmentActionLaunchSnapshot,
} from "@mcode/contracts";
import type { WebSocket } from "ws";

/** Dependency-injection token for the boot-selected Terminal backend. */
export const TERMINAL_BACKEND_TOKEN = "TerminalBackend";

/** Streams legacy Terminal output and exit events to connected clients. */
export interface TerminalBackendSender {
  json(channel: string, data: Record<string, unknown>): void;
  data(ptyId: string, seq: number, bytes: Uint8Array): void;
  frame?(client: WebSocket, bytes: Uint8Array): void;
}

/** Typed failure returned by the modern Terminal management boundary. */
export class TerminalBackendError extends Error {
  readonly correlationId: string;

  constructor(
    readonly code: TerminalErrorCode,
    readonly retry: TerminalRetryClass,
    message: string,
    correlationId = `corr-${crypto.randomUUID()}`,
    readonly data?: TerminalProfileInUseData,
  ) {
    super(message);
    this.name = "TerminalBackendError";
    this.correlationId = correlationId;
  }
}

/** Result of a legacy Terminal reattachment. */
export type TerminalReattachResult =
  | { mode: "delta" }
  | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number }
  | { mode: "reset"; discardThrough: number };

/** Exit observation for a private prepared terminal command session. */
export interface PreparedTerminalCommandExit {
  readonly exitCode: number | null;
}

/** Headless private command session retained by a Project Action lifecycle owner. */
export interface PreparedTerminalCommandSession {
  readonly terminalSessionId: string;
  readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
  onOutput(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exit: PreparedTerminalCommandExit) => void): () => void;
  stop(): Promise<void>;
}

/** Typed pre-spawn failure that preserves resolved Action launch facts without environment values. */
export class PreparedTerminalCommandStartError extends Error {
  constructor(
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot,
    readonly original: unknown,
  ) {
    super("Prepared command session creation failed");
    this.name = "PreparedTerminalCommandStartError";
  }
}

/** Exact launch facts that a shared-command approval bound before the backend starts a session. */
export interface PreparedTerminalCommandExpectation {
  readonly terminal: {
    readonly executable: string;
    readonly arguments: readonly string[];
  } | null;
}

/** Typed pre-spawn failure raised when the Terminal profile changed after shared-command approval. */
export class PreparedTerminalCommandApprovalMismatchError extends Error {
  constructor(readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot) {
    super("Prepared command approval no longer matches the Terminal launch");
    this.name = "PreparedTerminalCommandApprovalMismatchError";
  }
}

/** Exact noninteractive command request owned by a Project Action slot. */
export interface PreparedTerminalCommandRequest {
  readonly threadId: string;
  readonly script: string;
  readonly expectedLaunch?: PreparedTerminalCommandExpectation;
}

/** Boot-selected Terminal backend used by server orchestration and transport. */
export abstract class TerminalBackend {
  abstract capabilities(): TerminalBackendCapabilities;
  abstract setSender(sender: TerminalBackendSender): void;
  abstract create(scopeId: string): { ptyId: string; shell: string };
  abstract pause(ptyId: string): void;
  abstract resume(ptyId: string): void;
  abstract onBufferedAmountTick(bufferedAmount: number): void;
  abstract write(ptyId: string, data: string): void;
  abstract resize(ptyId: string, cols: number, rows: number): void;
  abstract kill(
    ptyId: string,
    reason?: "user-requested-process-tree-close" | "app-shutdown",
  ): Promise<void>;
  abstract killByThread(threadId: string): Promise<void>;
  abstract shutdown(): Promise<void>;
  abstract setGracefulKill(enabled: boolean): void;
  abstract reattach(ptyId: string, lastSeq: number, cold?: boolean): TerminalReattachResult;
  abstract checkpoint(ptyId: string, seq: number, data: string): { accepted: boolean };
  abstract listActiveSessions(): Array<{ ptyId: string; threadId: string }>;
  abstract hasChildren(ptyId: string): Promise<{ hasChildren: boolean }>;

  /** Starts one headless exact command session using this selected backend's capacity and tracking. */
  startPreparedCommand(_input: PreparedTerminalCommandRequest): Promise<PreparedTerminalCommandSession> {
    return Promise.reject(new Error("Prepared command sessions are unavailable"));
  }

  /** Routes one strict Terminal v1 management operation for the owning client. */
  routeV1(_method: string, _params: unknown, _client: WebSocket): Promise<unknown> {
    return Promise.reject(new Error("Terminal v1 transport is unavailable"));
  }

  /** Applies one strict Terminal v1 binary frame from the owning client. */
  handleV1Frame(_client: WebSocket, _bytes: Uint8Array): Promise<void> {
    return Promise.reject(new Error("Terminal v1 transport is unavailable"));
  }

  /** Releases controller leases and uploads owned by a disconnected client. */
  disconnectClient(_client: WebSocket): void {}
}
