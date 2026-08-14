import { withTerminalTimeout } from "../terminal-client";
import type {
  TerminalClient,
  TerminalCheckpoint,
  TerminalClientSubscription,
  TerminalClientReattachResult,
  TerminalRpcCall,
  TerminalActiveSession,
} from "../terminal-client";
import {
  emitPtyReconnectGap,
  onPtyData,
  onPtyExit,
  onPtyReconnectGap,
} from "../pty-data-registry";

/** Adapts the frozen version 0 Terminal RPCs to the client transport seam. */
export class LegacyTerminalClient implements TerminalClient {
  constructor(private readonly rpc: TerminalRpcCall) {}

  /** Creates one legacy PTY. */
  create(threadId: string, _replacesSessionId?: string): Promise<{ ptyId: string; shell: string }> {
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

  /** Detaches the legacy renderer through its compatibility RPC. */
  async detachForSwitch(
    ptyId: string,
    checkpoint?: Promise<TerminalCheckpoint | undefined>,
  ): Promise<void> {
    const state = checkpoint
      ? await withTerminalTimeout(checkpoint).catch(() => undefined)
      : undefined;
    await withTerminalTimeout(
      (state ? this.checkpoint(ptyId, state.seq, state.data) : Promise.resolve())
        .catch(() => undefined)
        .then(() => this.pause(ptyId)),
    );
  }

  /** Bridges legacy global push events during the compatibility window. */
  subscribe(ptyId: string, subscription: TerminalClientSubscription): () => void {
    const unsubs = [
      subscription.onData ? onPtyData(ptyId, subscription.onData) : undefined,
      subscription.onExit
        ? onPtyExit(ptyId, (detail) => subscription.onExit?.({
            ptyId: detail.ptyId,
            code: detail.code,
            state: "exited",
            exit: { code: detail.code, signal: null, reason: "natural" },
          }))
        : undefined,
      subscription.onReconnectGap
        ? onPtyReconnectGap(ptyId, () => subscription.onReconnectGap?.())
        : undefined,
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }

  /** Delivers a reconnect gap through the legacy compatibility registry. */
  notifyReconnectGap(ptyId: string): void {
    emitPtyReconnectGap({ ptyId });
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
    return withTerminalTimeout(this.rpc("terminal.checkpoint", { ptyId, seq, data }));
  }

  /** Lists all active legacy PTYs. */
  async listActive(): Promise<TerminalActiveSession[]> {
    const sessions = await this.rpc<Array<{ ptyId: string; threadId: string }>>("terminal.listActive", {});
    return sessions.map((session) => ({ ...session, state: "running" }));
  }

  /** Reports whether one legacy PTY owns child processes. */
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return this.rpc("terminal.hasChildren", { ptyId });
  }
}
