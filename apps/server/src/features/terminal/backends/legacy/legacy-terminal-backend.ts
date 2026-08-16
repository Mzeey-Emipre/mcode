import { injectable } from "tsyringe";
import type { TerminalBackendCapabilities } from "@mcode/contracts";
import {
  TerminalBackend,
  type TerminalBackendSender,
  type TerminalReattachResult,
} from "../terminal-backend.js";
import { TerminalService } from "./terminal-service.js";

const LEGACY_CAPABILITIES = Object.freeze({
  contractVersion: 0,
  backend: "legacy",
  publicFrameVersion: 0,
  recovery: Object.freeze({ replay: true, checkpoint: true, gap: true }),
} as const satisfies TerminalBackendCapabilities);

/** Adapts the frozen version 0 Terminal service to the boot-selected backend seam. */
@injectable()
export class LegacyTerminalBackend extends TerminalBackend {
  constructor(private readonly terminalService: TerminalService) {
    super();
  }

  /** Reports the selected legacy protocol and its recovery features. */
  capabilities(): TerminalBackendCapabilities {
    return LEGACY_CAPABILITIES;
  }

  /** Installs the output sender used by the legacy service. */
  setSender(sender: TerminalBackendSender): void {
    this.terminalService.setSender(sender);
  }

  /** Creates one legacy PTY for a thread or workspace scope. */
  create(scopeId: string): { ptyId: string; shell: string } {
    return this.terminalService.create(scopeId);
  }

  /** Pauses legacy PTY output for a client request. */
  pause(ptyId: string): void {
    this.terminalService.pause(ptyId);
  }

  /** Resumes legacy PTY output for a client request. */
  resume(ptyId: string): void {
    this.terminalService.resume(ptyId);
  }

  /** Applies WebSocket buffered-byte pressure to all legacy PTYs. */
  onBufferedAmountTick(bufferedAmount: number): void {
    this.terminalService.onBufferedAmountTick(bufferedAmount);
  }

  /** Writes input to one legacy PTY. */
  write(ptyId: string, data: string): void {
    this.terminalService.write(ptyId, data);
  }

  /** Resizes one legacy PTY. */
  resize(ptyId: string, cols: number, rows: number): void {
    this.terminalService.resize(ptyId, cols, rows);
  }

  /** Closes one legacy PTY. */
  kill(
    ptyId: string,
    reason?: "user-requested-process-tree-close" | "app-shutdown",
  ): Promise<void> {
    return this.terminalService.kill(ptyId, reason);
  }

  /** Closes all legacy PTYs for one scope. */
  killByThread(threadId: string): Promise<void> {
    return this.terminalService.killByThread(threadId);
  }

  /** Closes every legacy PTY and releases service resources. */
  shutdown(): Promise<void> {
    return this.terminalService.shutdown();
  }

  /** Selects graceful process-tree shutdown for app exit. */
  setGracefulKill(enabled: boolean): void {
    this.terminalService.setGracefulKill(enabled);
  }

  /** Replays retained legacy output after reconnect. */
  reattach(ptyId: string, lastSeq: number, cold?: boolean): TerminalReattachResult {
    return this.terminalService.reattach(ptyId, lastSeq, cold);
  }

  /** Stores one bounded legacy renderer checkpoint. */
  checkpoint(ptyId: string, seq: number, data: string): { accepted: boolean } {
    return this.terminalService.checkpoint(ptyId, seq, data);
  }

  /** Lists all active legacy PTYs. */
  listActiveSessions(): Array<{ ptyId: string; threadId: string }> {
    return this.terminalService.listActiveSessions();
  }

  /** Reports whether one legacy PTY owns child processes. */
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return this.terminalService.hasChildren(ptyId);
  }
}
