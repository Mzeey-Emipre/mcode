import { inject, injectable } from "tsyringe";
import type { TerminalBackendCapabilities } from "@mcode/contracts";
import {
  TerminalBackend,
  PreparedTerminalCommandApprovalMismatchError,
  type TerminalBackendSender,
  type PreparedTerminalCommandRequest,
  type PreparedTerminalCommandSession,
  type TerminalReattachResult,
} from "../terminal-backend.js";
import { TerminalService } from "./terminal-service.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TerminalProfileService } from "../../profiles/terminal-profile-service.js";
import { noninteractiveLaunch } from "../../commands/terminal-command-service.js";

const LEGACY_CAPABILITIES = Object.freeze({
  contractVersion: 0,
  backend: "legacy",
  publicFrameVersion: 0,
  recovery: Object.freeze({ replay: true, checkpoint: true, gap: true }),
} as const satisfies TerminalBackendCapabilities);

/** Adapts the frozen version 0 Terminal service to the boot-selected backend seam. */
@injectable()
export class LegacyTerminalBackend extends TerminalBackend {
  constructor(
    private readonly terminalService: TerminalService,
    @inject("ThreadRepo") private readonly threads: ThreadRepo,
    @inject(TerminalProfileService) private readonly profiles: TerminalProfileService,
  ) {
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

  /** Starts one exact hidden command using the legacy PTY's existing capacity and ownership tracking. */
  async startPreparedCommand(input: PreparedTerminalCommandRequest): Promise<PreparedTerminalCommandSession> {
    const thread = this.threads.findById(input.threadId);
    if (!thread || thread.deleted_at !== null) throw new Error("Prepared command Thread is unavailable");
    const profile = await this.profiles.resolveLaunchProfile({ workspaceId: thread.workspace_id });
    const launch = noninteractiveLaunch(profile.resolvedProfile, input.script);
    if (!launch) throw new Error("The current Terminal profile does not support noninteractive Project Actions");
    const checkoutPath = this.terminalService.resolveWorkingDirectory(input.threadId);
    if (!matchesExpectedPreparedLaunch(launch, input.expectedLaunch)) {
      throw new PreparedTerminalCommandApprovalMismatchError({
        platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        script: input.script,
        checkoutPath,
        terminal: { executable: launch.executable, arguments: [...launch.arguments] },
        environmentNames: [],
      });
    }
    const session = this.terminalService.startPreparedCommand(input.threadId, {
      executable: launch.executable,
      arguments: launch.arguments,
    });
    return {
      terminalSessionId: session.terminalSessionId,
      snapshot: {
        platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
        script: input.script,
        checkoutPath: session.checkoutPath,
        terminal: { executable: session.executable, arguments: session.arguments },
        environmentNames: session.environmentNames,
      },
      onOutput: session.onOutput,
      onExit: (listener) => session.onExit((exitCode) => listener({ exitCode })),
      stop: session.stop,
    };
  }
}

function matchesExpectedPreparedLaunch(
  launch: { readonly executable: string; readonly arguments: readonly string[] },
  expected: PreparedTerminalCommandRequest["expectedLaunch"],
): boolean {
  if (!expected) return true;
  return expected.terminal?.executable === launch.executable
    && expected.terminal.arguments.length === launch.arguments.length
    && expected.terminal.arguments.every(
      (argument, index) => normalizeLaunchArgument(argument) === normalizeLaunchArgument(launch.arguments[index] ?? ""),
    );
}

function normalizeLaunchArgument(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
