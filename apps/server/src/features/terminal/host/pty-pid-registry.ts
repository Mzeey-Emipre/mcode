import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Describes a single PTY process entry persisted in the registry.
 */
export interface PtyPidEntry {
  readonly pid: number;
  readonly ptyId: string;
  readonly imageName: string;
  /** ISO 8601 timestamp of when the PTY was spawned. */
  readonly spawnedAt: string;
}

/**
 * Persists active PTY PIDs to a JSON file for crash recovery.
 *
 * On a clean shutdown, call `clear()` to remove the file. On a crash the file
 * survives and can be read on next startup via `loadStale()`, which returns all
 * entries and then removes the file so the next clean run starts fresh.
 *
 * All file operations are synchronous to guarantee consistency from the
 * caller's perspective (no async flush window).
 */
export class PtyPidRegistry {
  private readonly entries: Map<string, PtyPidEntry>;
  private readonly filePath: string;

  /**
   * Creates a new registry backed by a JSON file in `dataDir`.
   *
   * @param dataDir - Directory where `pty-pids.json` is written.
   */
  constructor(dataDir: string) {
    this.entries = new Map();
    this.filePath = path.join(dataDir, "pty-pids.json");
  }

  /**
   * Registers a PTY process entry and flushes the updated state to disk.
   * If a pty with the same `ptyId` already exists, the entry is replaced.
   *
   * @param ptyId - Unique identifier for the PTY session.
   * @param pid - OS process ID of the shell.
   * @param imageName - Name of the spawned process image (e.g. "bash", "powershell.exe").
   */
  register(ptyId: string, pid: number, imageName: string): void {
    const entry: PtyPidEntry = {
      ptyId,
      pid,
      imageName,
      spawnedAt: new Date().toISOString(),
    };
    this.entries.set(ptyId, entry);
    this._flush();
  }

  /**
   * Removes a PTY entry from the registry and flushes the updated state to disk.
   * A no-op if the `ptyId` is not currently registered.
   *
   * @param ptyId - Unique identifier for the PTY session to remove.
   */
  deregister(ptyId: string): void {
    this.entries.delete(ptyId);
    this._flush();
  }

  /**
   * Reads all stale entries left over from a previous (crashed) server run,
   * removes the backing file, and returns the entries.
   *
   * Returns an empty array if the file does not exist, cannot be read, or
   * contains invalid JSON.
   */
  loadStale(): PtyPidEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      fs.unlinkSync(this.filePath);
      if (!Array.isArray(parsed)) return [];
      // Runtime shape guard: drop malformed entries rather than crashing the
      // reaper or passing garbage PIDs to process.kill.
      return parsed.filter(
        (e): e is PtyPidEntry =>
          e !== null &&
          typeof e === "object" &&
          typeof e.pid === "number" &&
          Number.isInteger(e.pid) &&
          e.pid > 0 &&
          typeof e.ptyId === "string" &&
          typeof e.imageName === "string" &&
          typeof e.spawnedAt === "string",
      );
    } catch {
      return [];
    }
  }

  /**
   * Clears all in-memory entries and removes the backing file from disk.
   * Intended to be called on clean shutdown. Safe to call when the file
   * does not exist.
   */
  clear(): void {
    this.entries.clear();
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      /* file may not exist - that is fine */
    }
  }

  /**
   * Writes the current entries map to disk atomically via a tmp-then-rename
   * pattern, so a crash mid-write never leaves a partially written file.
   */
  private _flush(): void {
    const tmpPath = `${this.filePath}.tmp`;
    const data = JSON.stringify(Array.from(this.entries.values()), null, 2);
    fs.writeFileSync(tmpPath, data, { encoding: "utf-8" });
    fs.renameSync(tmpPath, this.filePath);
  }
}
