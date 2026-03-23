/**
 * Manages PTY (pseudo-terminal) sessions for the integrated terminal.
 * Each PTY is tied to a thread ID, with a maximum of 4 PTYs per thread.
 */

import { spawn } from "node-pty";
import type { IPty, IDisposable } from "node-pty";
import { v4 as uuid } from "uuid";
import { logger } from "./logger.js";

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

/** Sender function signature, matching Electron's webContents.send. */
type Sender = (channel: string, ...args: unknown[]) => void;

/** Determine the default shell for the current platform. */
function defaultShell(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env["SHELL"] ?? "/bin/bash";
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private threadIndex = new Map<string, Set<string>>();
  private sender: Sender | null = null;

  /**
   * Attach a sender function (typically `webContents.send`) for streaming
   * PTY data and exit events to the renderer process.
   */
  setSender(fn: Sender): void {
    this.sender = fn;
  }

  /**
   * Spawn a new PTY session tied to the given thread.
   * @returns The unique PTY session ID.
   * @throws If the thread already has MAX_PTYS_PER_THREAD sessions.
   */
  create(threadId: string, cwd: string): string {
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
      this.sender?.("pty:data", { ptyId: id, data });
    });

    const exitDisposable = pty.onExit(({ exitCode }) => {
      this.sender?.("pty:exit", { ptyId: id, exitCode });
      this.removePty(id);
    });

    const session: PtySession = { id, threadId, pty, dataDisposable, exitDisposable };
    this.sessions = new Map([...this.sessions, [id, session]]);

    const updatedSet = new Set(threadPtys ?? []);
    updatedSet.add(id);
    this.threadIndex = new Map([...this.threadIndex, [threadId, updatedSet]]);

    return id;
  }

  /**
   * Forward keystrokes to a PTY session.
   * @throws If the PTY session is not found.
   */
  write(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) {
      throw new Error(`PTY not found: ${ptyId}`);
    }
    session.pty.write(data);
  }

  /**
   * Resize a PTY session.
   * @throws If the PTY session is not found.
   */
  resize(ptyId: string, cols: number, rows: number): void {
    const session = this.sessions.get(ptyId);
    if (!session) {
      throw new Error(`PTY not found: ${ptyId}`);
    }
    session.pty.resize(cols, rows);
  }

  /** Kill a single PTY session. No-op if the ID is unknown. */
  kill(ptyId: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) {
      return;
    }
    this.destroyPty(session);
    this.removePty(ptyId);
  }

  /** Kill all PTY sessions for a given thread. */
  killByThread(threadId: string): void {
    const ptyIds = this.threadIndex.get(threadId);
    if (!ptyIds) {
      return;
    }
    for (const ptyId of ptyIds) {
      const session = this.sessions.get(ptyId);
      if (session) {
        this.destroyPty(session);
      }
    }
    // Remove all entries for this thread
    const newSessions = new Map(this.sessions);
    for (const ptyId of ptyIds) {
      newSessions.delete(ptyId);
    }
    this.sessions = newSessions;

    const newIndex = new Map(this.threadIndex);
    newIndex.delete(threadId);
    this.threadIndex = newIndex;
  }

  /** Kill all PTY sessions across all threads. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      this.destroyPty(session);
    }
    this.sessions = new Map();
    this.threadIndex = new Map();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private destroyPty(session: PtySession): void {
    try {
      session.dataDisposable.dispose();
      session.exitDisposable.dispose();
      session.pty.kill();
    } catch (err) {
      logger.warn("Failed to kill PTY", { id: session.id, error: err });
    }
  }

  private removePty(ptyId: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) {
      return;
    }

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
