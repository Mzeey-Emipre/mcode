/**
 * PTY (pseudo-terminal) management service.
 * Spawns and manages terminal sessions tied to threads.
 * Extracted from apps/desktop/src/main/pty-manager.ts.
 */

import { injectable, inject } from "tsyringe";
import { isAbsolute } from "path";
import { existsSync, statSync } from "fs";
import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";
import { v4 as uuid } from "uuid";
import { logger } from "@mcode/shared";
import { killProcessTree } from "./process-kill.js";
import type { ThreadRepo } from "../repositories/thread-repo";
import type { WorkspaceRepo } from "../repositories/workspace-repo";
import type { GitService } from "./git-service";

const MAX_PTYS_PER_THREAD = 4;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM_NAME = "xterm-256color";

/** Immutable record describing a single PTY session. */
interface PtySession {
  readonly id: string;
  readonly threadId: string;
  readonly pty: IPty;
  readonly dataDisposable: IDisposable;
  readonly exitDisposable: IDisposable;
}

/** Callback for sending PTY data and exit events to connected clients. */
type PtySender = (
  channel: string,
  data: Record<string, unknown>,
) => void;

/** Determine the default shell for the current platform. */
function defaultShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env["SHELL"] ?? "/bin/bash";
}

/** Manages PTY sessions for the integrated terminal. */
@injectable()
export class TerminalService {
  private sessions = new Map<string, PtySession>();
  private threadIndex = new Map<string, Set<string>>();
  private sender: PtySender | null = null;

  constructor(
    @inject("ThreadRepo") private readonly threadRepo: ThreadRepo,
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject("GitService") private readonly gitService: GitService,
  ) {}

  /** Set the sender function used to stream PTY data to connected clients. */
  setSender(fn: PtySender): void {
    this.sender = fn;
  }

  /**
   * Spawn a new PTY session tied to the given thread.
   * Resolves the working directory from the thread's workspace and worktree path.
   * @returns The unique PTY session ID.
   */
  create(threadId: string): string {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${thread.workspace_id}`);
    }

    const cwd = this.gitService.resolveWorkingDir(
      workspace.path,
      thread.mode,
      thread.worktree_path,
    );

    if (
      !isAbsolute(cwd) ||
      !existsSync(cwd) ||
      !statSync(cwd).isDirectory()
    ) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }

    const threadPtys = this.threadIndex.get(threadId);
    const count = threadPtys?.size ?? 0;

    if (count >= MAX_PTYS_PER_THREAD) {
      throw new Error(
        `Maximum PTY limit (${MAX_PTYS_PER_THREAD}) reached for thread ${threadId}`,
      );
    }

    const id = uuid();
    const shell = defaultShell();

    logger.info("Spawning PTY", { id, threadId, shell, cwd });

    const pty = spawn(shell, [], {
      name: TERM_NAME,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
    });

    const dataDisposable = pty.onData((data: string) => {
      this.sender?.("terminal.data", { ptyId: id, data });
    });

    const exitDisposable = pty.onExit(({ exitCode }) => {
      this.sender?.("terminal.exit", { ptyId: id, code: exitCode });
      this.removePty(id);
    });

    const session: PtySession = {
      id,
      threadId,
      pty,
      dataDisposable,
      exitDisposable,
    };
    this.sessions = new Map([...this.sessions, [id, session]]);

    const updatedSet = new Set(threadPtys ?? []);
    updatedSet.add(id);
    this.threadIndex = new Map([
      ...this.threadIndex,
      [threadId, updatedSet],
    ]);

    return id;
  }

  /** Forward keystrokes to a PTY session. */
  write(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    session.pty.write(data);
  }

  /** Resize a PTY session. */
  resize(ptyId: string, cols: number, rows: number): void {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    session.pty.resize(cols, rows);
  }

  /** Kill a single PTY session. No-op if the ID is unknown. */
  async kill(ptyId: string): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    await this.destroyPty(session);
    this.removePty(ptyId);
  }

  /** Kill all PTY sessions for a given thread, concurrently. */
  async killByThread(threadId: string): Promise<void> {
    const ptys = this.threadIndex.get(threadId);
    if (!ptys || ptys.size === 0) return;
    // Kill all PTYs concurrently: each killProcessTree is independent.
    await Promise.all([...ptys].map((ptyId) => this.kill(ptyId)));
    logger.info("All PTYs killed for thread", { threadId });
  }

  /** Kill all PTY sessions across all threads. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((ptyId) => this.kill(ptyId)));
  }

  private async destroyPty(session: PtySession): Promise<void> {
    try {
      session.dataDisposable.dispose();
    } catch (err) {
      logger.warn("Failed to dispose data listener", {
        id: session.id,
        error: err,
      });
    }
    try {
      session.exitDisposable.dispose();
    } catch (err) {
      logger.warn("Failed to dispose exit listener", {
        id: session.id,
        error: err,
      });
    }
    // Kill the entire process tree (grandchildren like git, npm) before the PTY
    // shell itself. On Windows, pty.kill() only kills the direct shell process;
    // grandchildren survive and keep the worktree directory locked.
    await killProcessTree(session.pty.pid);
    try {
      session.pty.kill();
    } catch (err) {
      logger.warn("Failed to kill PTY process", {
        id: session.id,
        error: err,
      });
    }
  }

  private removePty(ptyId: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) return;

    const newSessions = new Map(this.sessions);
    newSessions.delete(ptyId);
    this.sessions = newSessions;

    const threadPtys = this.threadIndex.get(session.threadId);
    if (threadPtys) {
      const updated = new Set(threadPtys);
      updated.delete(ptyId);
      const newIndex = new Map(this.threadIndex);
      if (updated.size === 0) {
        newIndex.delete(session.threadId);
      } else {
        newIndex.set(session.threadId, updated);
      }
      this.threadIndex = newIndex;
    }
  }
}
