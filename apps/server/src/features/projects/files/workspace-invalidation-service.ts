/**
 * Watches local workspace scopes owned by WebSocket connections and reports
 * bounded filesystem invalidations to their consumers.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { injectable } from "tsyringe";
import type { WebSocket } from "ws";
import { sendToClient } from "../../../application/transport/push.js";

const DEBOUNCE_MS = 100;
const MAX_CHANGED_PATHS = 100;

interface WatchEntry {
  readonly root: string;
  readonly workspaceId: string;
  readonly threadId: string | undefined;
  readonly watcher: NodeFS.FSWatcher;
  readonly paths: Set<string>;
  overflow: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Owns local workspace watchers for active WebSocket connections. */
@injectable()
export class WorkspaceInvalidationService {
  private readonly watchesByClient = new Map<WebSocket, Map<string, WatchEntry>>();

  /** Starts one local watch for a client and workspace scope when needed. */
  watch(client: WebSocket, workspaceId: string, threadId: string | undefined, root: string): void {
    const canonicalRoot = NodeFS.realpathSync(root);
    const key = `${workspaceId}:${threadId ?? ""}:${canonicalRoot}`;
    const clientWatches = this.watchesByClient.get(client) ?? new Map<string, WatchEntry>();
    if (clientWatches.has(key)) return;

    let entry: WatchEntry;
    const watcher = NodeFS.watch(canonicalRoot, { recursive: true }, (_event, filename) => {
      this.recordChange(client, entry, filename);
    });
    entry = {
      root: canonicalRoot,
      workspaceId,
      threadId,
      watcher,
      paths: new Set(),
      overflow: false,
      timer: null,
    };
    clientWatches.set(key, entry);
    this.watchesByClient.set(client, clientWatches);
    watcher.on("error", () => this.removeWatch(client, key, entry));
  }

  /** Closes every local watch owned by a disconnected client. */
  unwatchClient(client: WebSocket): void {
    const clientWatches = this.watchesByClient.get(client);
    if (!clientWatches) return;
    for (const entry of clientWatches.values()) this.close(entry);
    this.watchesByClient.delete(client);
  }

  /** Closes every local watch during server shutdown. */
  dispose(): void {
    for (const client of this.watchesByClient.keys()) this.unwatchClient(client);
  }

  private recordChange(client: WebSocket, entry: WatchEntry, filename: string | Buffer | null): void {
    if (!this.isActive(client, entry)) return;
    if (filename === null) {
      entry.paths.clear();
      entry.overflow = true;
      this.scheduleFlush(client, entry);
      return;
    }
    const changedPath = this.relativePathWithinRoot(entry.root, filename);
    if (changedPath === null) return;
    if (!entry.overflow) {
      entry.paths.add(changedPath);
      if (entry.paths.size > MAX_CHANGED_PATHS) {
        entry.paths.clear();
        entry.overflow = true;
      }
    }
    this.scheduleFlush(client, entry);
  }

  private flush(client: WebSocket, entry: WatchEntry): void {
    if (!this.isActive(client, entry)) return;
    entry.timer = null;
    const wholeWorkspace = entry.overflow;
    const changedPaths = wholeWorkspace ? [] : [...entry.paths];
    entry.paths.clear();
    entry.overflow = false;
    sendToClient(client, "files.changed", {
      workspaceId: entry.workspaceId,
      ...(entry.threadId ? { threadId: entry.threadId } : {}),
      changedPaths,
      wholeWorkspace,
    });
  }

  private close(entry: WatchEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.watcher.close();
  }

  private removeWatch(client: WebSocket, key: string, entry: WatchEntry): void {
    const clientWatches = this.watchesByClient.get(client);
    if (clientWatches?.get(key) !== entry) return;
    this.close(entry);
    clientWatches.delete(key);
    if (clientWatches.size === 0) this.watchesByClient.delete(client);
  }

  private scheduleFlush(client: WebSocket, entry: WatchEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flush(client, entry), DEBOUNCE_MS);
  }

  private isActive(client: WebSocket, entry: WatchEntry): boolean {
    const clientWatches = this.watchesByClient.get(client);
    if (!clientWatches) return false;
    for (const activeEntry of clientWatches.values()) {
      if (activeEntry === entry) return true;
    }
    return false;
  }

  private relativePathWithinRoot(root: string, filename: string | Buffer | null): string | null {
    if (filename === null) return null;
    const rawPath = filename.toString();
    const fullPath = NodePath.resolve(root, rawPath);
    const canonicalPath = this.nearestExistingCanonicalPath(fullPath);
    if (canonicalPath === null) return null;
    const canonicalRelativePath = NodePath.relative(root, canonicalPath);
    if (canonicalRelativePath !== "" && isOutsideRelativePath(canonicalRelativePath)) return null;
    const relativePath = NodePath.relative(root, fullPath);
    if (isOutsideRelativePath(relativePath)) return null;
    if (isGitFsmonitorCookie(relativePath)) return null;
    return relativePath;
  }

  private nearestExistingCanonicalPath(path: string): string | null {
    let candidate = path;
    while (true) {
      if (NodeFS.existsSync(candidate)) {
        try {
          return NodeFS.realpathSync(candidate);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
      const parent = NodePath.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function isOutsideRelativePath(path: string): boolean {
  return path === "" || path === ".." || path.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(path);
}

function isGitFsmonitorCookie(path: string): boolean {
  const parts = path.split(NodePath.sep);
  return parts[0] === ".git" && parts[1] === "fsmonitor--daemon" && parts[2] === "cookies";
}
