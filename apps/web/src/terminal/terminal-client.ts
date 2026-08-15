import type {
  TerminalExitMetadata,
  TerminalGap,
  TerminalSessionState,
} from "@mcode/contracts";

/** Upper bound for renderer-side Terminal cleanup RPCs. */
export const TERMINAL_CLEANUP_TIMEOUT_MS = 2_000;

/** Reattachment result returned by the legacy Terminal transport. */
export type TerminalClientReattachResult =
  | { mode: "delta" }
  | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number }
  | { mode: "reset"; discardThrough: number };

/** Raw JSON RPC function used by Terminal client adapters. */
export type TerminalRpcCall = <T>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

/** Resolves or rejects one Terminal operation within the cleanup deadline. */
export function withTerminalTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Terminal operation timed out"));
    }, TERMINAL_CLEANUP_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Data delivered to a Terminal renderer controller. */
export interface TerminalDataEvent {
  readonly ptyId: string;
  readonly payload: Uint8Array;
  readonly seq: number;
}

/** Exit delivered to a Terminal renderer controller. */
export interface TerminalExitEvent {
  readonly ptyId: string;
  readonly code: number;
  readonly state: "exited" | "failed";
  readonly exit: TerminalExitMetadata;
}

/** Events delivered by one client-owned Terminal attachment. */
export interface TerminalClientSubscription {
  readonly onData?: (event: TerminalDataEvent) => void;
  readonly onExit?: (event: TerminalExitEvent) => void;
  readonly onReconnectGap?: (gap?: TerminalGap) => void;
}

/** Serialized renderer state to preserve before releasing a shell switch. */
export interface TerminalCheckpoint {
  readonly seq: number;
  readonly data: string;
}

/** Server-authoritative Terminal session projected into the renderer store. */
export interface TerminalActiveSession {
  readonly ptyId: string;
  readonly threadId: string;
  readonly state: TerminalSessionState;
  readonly exit?: TerminalExitMetadata;
}

/** Client-side adapter for the Terminal backend selected at server boot. */
export interface TerminalClient {
  create(threadId: string, replacesSessionId?: string): Promise<{ ptyId: string; shell: string }>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  kill(ptyId: string): Promise<void>;
  pause(ptyId: string): Promise<void>;
  resume(ptyId: string): Promise<void>;
  /** Subscribes a renderer controller to one client's attachment delivery. */
  subscribe(ptyId: string, subscription: TerminalClientSubscription): () => void;
  /** Detaches a renderer because its shell is being replaced. */
  detachForSwitch(
    ptyId: string,
    checkpoint?: Promise<TerminalCheckpoint | undefined>,
  ): Promise<void>;
  /** Delivers a reconnect gap through this client's event ownership. */
  notifyReconnectGap(ptyId: string): void;
  killByThread(threadId: string): Promise<void>;
  reattach(
    ptyId: string,
    lastSeq: number,
    cold?: boolean,
  ): Promise<TerminalClientReattachResult>;
  checkpoint(ptyId: string, seq: number, data: string): Promise<{ accepted: boolean }>;
  listActive(): Promise<TerminalActiveSession[]>;
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }>;
  acknowledgeOutput?(ptyId: string, seq: number): void;
}
