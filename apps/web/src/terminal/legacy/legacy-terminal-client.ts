import type {
  TerminalClient,
  TerminalClientReattachResult,
  TerminalRpcCall,
} from "../terminal-client";

/** Adapts the frozen version 0 Terminal RPCs to the client transport seam. */
export class LegacyTerminalClient implements TerminalClient {
  constructor(private readonly rpc: TerminalRpcCall) {}

  /** Creates one legacy PTY. */
  create(threadId: string): Promise<{ ptyId: string; shell: string }> {
    return this.rpc("terminal.create", { threadId });
  }

  /** Writes input to one legacy PTY. */
  write(ptyId: string, data: string): Promise<void> {
    return this.rpc("terminal.write", { ptyId, data });
  }

  /** Resizes one legacy PTY. */
  resize(ptyId: string, cols: number, rows: number): Promise<void> {
    return this.rpc("terminal.resize", { ptyId, cols, rows });
  }

  /** Closes one legacy PTY. */
  kill(ptyId: string): Promise<void> {
    return this.rpc("terminal.kill", { ptyId });
  }

  /** Pauses output from one legacy PTY. */
  pause(ptyId: string): Promise<void> {
    return this.rpc("terminal.pause", { ptyId });
  }

  /** Resumes output from one legacy PTY. */
  resume(ptyId: string): Promise<void> {
    return this.rpc("terminal.resume", { ptyId });
  }

  /** Closes all legacy PTYs for one scope. */
  killByThread(threadId: string): Promise<void> {
    return this.rpc("terminal.killByThread", { threadId });
  }

  /** Reattaches to one legacy PTY and restores retained output. */
  reattach(
    ptyId: string,
    lastSeq: number,
    cold?: boolean,
  ): Promise<TerminalClientReattachResult> {
    return this.rpc("terminal.reattach", { ptyId, lastSeq, cold });
  }

  /** Stores one bounded legacy renderer checkpoint. */
  checkpoint(ptyId: string, seq: number, data: string): Promise<{ accepted: boolean }> {
    return this.rpc("terminal.checkpoint", { ptyId, seq, data });
  }

  /** Lists all active legacy PTYs. */
  listActive(): Promise<Array<{ ptyId: string; threadId: string }>> {
    return this.rpc("terminal.listActive", {});
  }

  /** Reports whether one legacy PTY owns child processes. */
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return this.rpc("terminal.hasChildren", { ptyId });
  }
}
