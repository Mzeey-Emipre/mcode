import type {
  TerminalBackendCapabilities,
  TerminalErrorCode,
  TerminalProfileInUseData,
  TerminalRetryClass,
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
