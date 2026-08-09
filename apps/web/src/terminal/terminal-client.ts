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

/** Client-side adapter for the Terminal backend selected at server boot. */
export interface TerminalClient {
  create(threadId: string): Promise<{ ptyId: string; shell: string }>;
  write(ptyId: string, data: string): Promise<void>;
  resize(ptyId: string, cols: number, rows: number): Promise<void>;
  kill(ptyId: string): Promise<void>;
  pause(ptyId: string): Promise<void>;
  resume(ptyId: string): Promise<void>;
  killByThread(threadId: string): Promise<void>;
  reattach(
    ptyId: string,
    lastSeq: number,
    cold?: boolean,
  ): Promise<TerminalClientReattachResult>;
  checkpoint(ptyId: string, seq: number, data: string): Promise<{ accepted: boolean }>;
  listActive(): Promise<Array<{ ptyId: string; threadId: string }>>;
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }>;
}
