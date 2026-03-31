import type {
  McodeTransport,
  Workspace,
  Thread,
  Message,
  GitBranch,
  WorktreeInfo,
  AttachmentMeta,
  SkillInfo,
  PrInfo,
  PrDetail,
  PermissionMode,
  ToolCallRecord,
  Settings,
} from "./types";
import type { ReasoningLevel } from "@mcode/contracts";

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_MS = 1000;
/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_MS = 30_000;

type Listener = (data: unknown) => void;

/**
 * Minimal event emitter for push channel subscriptions.
 * Components subscribe via `on()` and receive server-pushed payloads.
 */
export class PushEmitter {
  private listeners = new Map<string, Set<Listener>>();

  /** Subscribe to a push channel. Returns an unsubscribe function. */
  on(channel: string, fn: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(channel);
    };
  }

  /** Emit a payload to all listeners on a channel. */
  emit(channel: string, data: unknown): void {
    const set = this.listeners.get(channel);
    if (set) {
      for (const fn of set) {
        try {
          fn(data);
        } catch (err) {
          console.error(`[PushEmitter] Error in listener for "${channel}":`, err);
        }
      }
    }
  }

  /** Return the set of channels that have at least one listener. */
  channels(): string[] {
    return [...this.listeners.keys()];
  }
}

/** Singleton push emitter shared between ws-transport and ws-events. */
export const pushEmitter = new PushEmitter();

/**
 * Channels suppressed from WebSocket push delivery.
 * When a MessagePort handles a channel, it adds the channel name here
 * so WebSocket push messages for that channel are silently dropped.
 */
export const suppressedPushChannels = new Set<string>();

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Describes the current state of the WebSocket connection. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting";

/** Options for configuring `createWsTransport` behavior. */
export interface WsTransportOptions {
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: ConnectionStatus) => void;
}

/**
 * Create a WebSocket-based transport that implements `McodeTransport`.
 *
 * Every method maps to a single JSON-RPC call matching the server's
 * `WS_METHODS` names. Server push messages are forwarded to `pushEmitter`.
 *
 * Includes automatic reconnection with exponential backoff and
 * re-subscription to push channels on reconnect.
 */
export function createWsTransport(
  url: string,
  options?: WsTransportOptions,
): McodeTransport & { close(): void; waitForConnection(timeoutMs: number): Promise<void> } {
  let ws: WebSocket;
  let idCounter = 0;
  let pending = new Map<string, PendingCall>();
  let closed = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resolves when the current WebSocket connection is open. */
  let ready: Promise<void>;
  let resolveReady: () => void;

  function resetReady() {
    ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
  }

  function connect() {
    resetReady();
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelay = MIN_RECONNECT_MS;
      resolveReady();
      options?.onStatusChange?.("connected");
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      // RPC response
      if (msg.id && pending.has(msg.id as string)) {
        const { resolve, reject } = pending.get(msg.id as string)!;
        pending.delete(msg.id as string);
        if (msg.error) {
          const err = msg.error as { message?: string };
          reject(new Error(err.message ?? "RPC error"));
        } else {
          resolve(msg.result);
        }
        return;
      }

      // Push message
      if (msg.type === "push") {
        const channel = msg.channel as string;
        // Skip channels handled by MessagePort to avoid duplicate events
        if (!suppressedPushChannels.has(channel)) {
          pushEmitter.emit(channel, msg.data);
        }
      }
    };

    ws.onclose = () => {
      rejectPending("WebSocket disconnected");
      if (!closed) {
        options?.onStatusChange?.("reconnecting");
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror; no extra handling needed.
    };
  }

  function rejectPending(reason: string) {
    for (const { reject } of pending.values()) {
      reject(new Error(reason));
    }
    pending = new Map();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      connect();
    }, reconnectDelay);
  }

  /** Send a JSON-RPC request and return the result. */
  async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    await ready;
    return new Promise<T>((resolve, reject) => {
      const id = `req_${++idCounter}`;
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * Wait for the WebSocket to establish a connection, or reject if
   * the timeout elapses first.
   */
  function waitForConnection(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const displayUrl = url.split("?")[0];
        reject(new Error(`Could not connect to server at ${displayUrl}`));
      }, timeoutMs);

      ready.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // Kick off the first connection.
  connect();

  return {
    waitForConnection,
    // Workspace
    listWorkspaces: () => rpc<Workspace[]>("workspace.list", {}),
    createWorkspace: (name, path) => rpc<Workspace>("workspace.create", { name, path }),
    deleteWorkspace: (id) => rpc<boolean>("workspace.delete", { id }),

    // Thread
    createThread: (workspaceId, title, mode, branch) =>
      rpc<Thread>("thread.create", { workspaceId, title, mode, branch }),
    listThreads: (workspaceId) => rpc<Thread[]>("thread.list", { workspaceId }),
    deleteThread: (threadId, cleanupWorktree) =>
      rpc<boolean>("thread.delete", { threadId, cleanupWorktree }),
    updateThreadTitle: (threadId, title) =>
      rpc<boolean>("thread.updateTitle", { threadId, title }),
    markThreadViewed: (threadId) => rpc<void>("thread.markViewed", { threadId }),

    // Git
    listBranches: (workspaceId) => rpc<GitBranch[]>("git.listBranches", { workspaceId }),
    getCurrentBranch: (workspaceId) => rpc<string>("git.currentBranch", { workspaceId }),
    checkoutBranch: (workspaceId, branch) =>
      rpc<void>("git.checkout", { workspaceId, branch }),
    listWorktrees: (workspaceId) => rpc<WorktreeInfo[]>("git.listWorktrees", { workspaceId }),

    // Agent
    sendMessage: (threadId, content, model?, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], reasoningLevel?: ReasoningLevel) =>
      rpc<void>("agent.send", { threadId, content, model, permissionMode, attachments, reasoningLevel }),
    createAndSendMessage: (
      workspaceId,
      content,
      model,
      permissionMode?,
      mode?,
      branch?,
      existingWorktreePath?,
      attachments?,
      reasoningLevel?,
    ) =>
      rpc<Thread>("agent.createAndSend", {
        workspaceId,
        content,
        model,
        permissionMode,
        mode,
        branch,
        existingWorktreePath,
        attachments,
        reasoningLevel,
      }),
    stopAgent: (threadId) => rpc<void>("agent.stop", { threadId }),
    readClipboardImage: () =>
      Promise.resolve(null as AttachmentMeta | null),
    saveClipboardFile: (data, mimeType, fileName) =>
      rpc<AttachmentMeta | null>("clipboard.saveFile", { data, mimeType, fileName }),
    getActiveAgentCount: () => rpc<number>("agent.activeCount", {}),

    // Messages
    getMessages: (threadId, limit) => rpc<Message[]>("message.list", { threadId, limit }),

    // Config
    discoverConfig: (workspacePath) =>
      rpc<Record<string, unknown>>("config.discover", { workspacePath }),

    // Meta
    getVersion: () => rpc<string>("app.version", {}),

    // Files
    listWorkspaceFiles: (workspaceId, threadId?) =>
      rpc<string[]>("file.list", { workspaceId, threadId }),
    readFileContent: (workspaceId, relativePath, threadId?) =>
      rpc<string>("file.read", { workspaceId, relativePath, threadId }),

    // Editor (delegated to desktopBridge; no-op over WS)
    detectEditors: async () => window.desktopBridge?.detectEditors() ?? [],
    openInEditor: async (editor, dirPath) => window.desktopBridge?.openInEditor(editor, dirPath),
    openInExplorer: async (dirPath) => window.desktopBridge?.openInExplorer(dirPath),

    // GitHub
    getBranchPr: (branch, cwd) =>
      rpc<PrInfo | null>("github.branchPr", { branch, cwd }),
    listOpenPrs: (workspaceId) => rpc<PrDetail[]>("github.listOpenPrs", { workspaceId }),
    fetchBranch: (workspaceId, branch, prNumber?) =>
      rpc<void>("git.fetchBranch", { workspaceId, branch, prNumber }),
    getPrByUrl: (url) => rpc<PrDetail | null>("github.prByUrl", { url }),

    // Skills
    listSkills: (cwd?) => rpc<SkillInfo[]>("skill.list", { cwd }),

    // Terminal (PTY)
    terminalCreate: (threadId) => rpc<string>("terminal.create", { threadId }),
    terminalWrite: (ptyId, data) => rpc<void>("terminal.write", { ptyId, data }),
    terminalResize: (ptyId, cols, rows) =>
      rpc<void>("terminal.resize", { ptyId, cols, rows }),
    terminalKill: (ptyId) => rpc<void>("terminal.kill", { ptyId }),
    terminalKillByThread: (threadId) =>
      rpc<void>("terminal.killByThread", { threadId }),

    // Tool call records
    listToolCallRecords: (messageId) =>
      rpc<ToolCallRecord[]>("toolCallRecord.list", { messageId }),
    listToolCallRecordsByParent: (parentToolCallId) =>
      rpc<ToolCallRecord[]>("toolCallRecord.listByParent", { parentToolCallId }),

    // Thread tasks
    getThreadTasks: (threadId: string) =>
      rpc<Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null>(
        "thread.getTasks", { threadId },
      ),

    // Snapshots
    getSnapshotDiff: (snapshotId, filePath?, maxLines?) =>
      rpc<string>("snapshot.getDiff", { snapshotId, filePath, maxLines }),
    cleanupSnapshots: () =>
      rpc<{ removed: number }>("snapshot.cleanup", {}),

    // Settings
    getSettings: () => rpc<Settings>("settings.get", {}),
    updateSettings: (partial) => rpc<Settings>("settings.update", partial as Record<string, unknown>),

    // Memory pressure
    setBackground: (background) => rpc<void>("memory.setBackground", { background }),

    // Lifecycle
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectPending("Transport closed");
      ws.close();
    },
  };
}
