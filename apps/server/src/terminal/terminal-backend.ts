import type { TerminalBackendCapabilities } from "@mcode/contracts";

/** Dependency-injection token for the boot-selected Terminal backend. */
export const TERMINAL_BACKEND_TOKEN = "TerminalBackend";

/** Streams legacy Terminal output and exit events to connected clients. */
export interface TerminalBackendSender {
  json(channel: string, data: Record<string, unknown>): void;
  data(ptyId: string, seq: number, bytes: Uint8Array): void;
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
}
