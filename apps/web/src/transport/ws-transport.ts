import type {
  McodeTransport,
  Workspace,
  Thread,
  GitBranch,
  WorktreeInfo,
  AttachmentMeta,
  SkillInfo,
  PrInfo,
  PrDetail,
  PermissionMode,
  ToolCallRecord,
  Settings,
  GitCommit,
  ProviderModelInfo,
} from "./types";
import type { PaginatedMessages, TurnSnapshot, PrDraft, CreatePrResult, ProviderUsageInfo } from "@mcode/contracts";
import type { ReasoningLevel } from "@mcode/contracts";

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_MS = 1000;
/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_MS = 30_000;
/** Number of immediate (delay=0) retries on auth failure before falling back to exponential backoff. */
const MAX_IMMEDIATE_AUTH_RETRIES = 3;

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
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "auth_failed";

/** Options for configuring `createWsTransport` behavior. */
export interface WsTransportOptions {
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Called between reconnect attempts to refresh the server URL. */
  discoverServerUrl?: () => Promise<string>;
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
  initialUrl: string,
  options?: WsTransportOptions,
): McodeTransport & { close(): void; waitForConnection(timeoutMs: number): Promise<void> } {
  let url = initialUrl;
  let ws: WebSocket;
  let idCounter = 0;
  let pending = new Map<string, PendingCall>();
  let closed = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Track consecutive auth failures so we apply backoff after 3 immediate
  // retries, preventing a tight loop when the token is persistently wrong.
  let consecutiveAuthFailures = 0;

  /** Resolves when the current WebSocket connection is open. */
  let ready: Promise<void>;
  let resolveReady: () => void;

  function resetReady() {
    ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
  }

  function connect(targetUrl?: string) {
    resetReady();
    ws = new WebSocket(targetUrl ?? url);

    ws.onopen = () => {
      reconnectDelay = MIN_RECONNECT_MS;
      consecutiveAuthFailures = 0;
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

    ws.onclose = (event: CloseEvent) => {
      rejectPending("WebSocket disconnected");
      if (!closed) {
        const isAuthFailure = event.code === 4001;
        options?.onStatusChange?.(isAuthFailure ? "auth_failed" : "reconnecting");
        scheduleReconnect(isAuthFailure);
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

  function scheduleReconnect(immediate = false) {
    if (reconnectTimer) return;

    // Auth failures use immediate reconnect (delay=0) for the first
    // MAX_IMMEDIATE_AUTH_RETRIES attempts, then fall back to normal backoff
    // to avoid a tight loop when the token is persistently wrong.
    const useImmediate = immediate && consecutiveAuthFailures < MAX_IMMEDIATE_AUTH_RETRIES;
    // Cap the counter so it does not grow unboundedly past the threshold.
    if (immediate && consecutiveAuthFailures < MAX_IMMEDIATE_AUTH_RETRIES) consecutiveAuthFailures++;
    const delay = useImmediate ? 0 : reconnectDelay;

    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      // Increase backoff for connectivity failures and for auth failures that
      // have exceeded the immediate-retry limit.
      if (!useImmediate) {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
      }
      if (options?.discoverServerUrl) {
        try {
          const newUrl = await options.discoverServerUrl();
          url = newUrl;
        } catch {
          // Discovery failed, retry with current URL
        }
      }
      connect();
    }, delay);
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
   * Send a binary payload via WebSocket with a JSON header for correlation.
   * 1. Sends a JSON text frame with upload metadata and request ID
   * 2. Immediately sends the binary data as a binary frame
   * 3. Server matches the binary frame to the header and responds on the same ID
   */
  async function rpcBinary<T>(
    method: string,
    meta: Record<string, unknown>,
    payload: ArrayBuffer,
  ): Promise<T> {
    await ready;
    return new Promise<T>((resolve, reject) => {
      const id = `req_${++idCounter}`;
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        // Step 1: Send JSON header
        ws.send(JSON.stringify({ type: "binary-upload", id, method, meta }));
        // Step 2: Send binary payload
        ws.send(payload);
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
    updateThreadSettings: (threadId, settings) =>
      rpc<boolean>("thread.updateSettings", {
        threadId,
        reasoningLevel: settings.reasoningLevel,
        interactionMode: settings.interactionMode,
        permissionMode: settings.permissionMode,
      }),
    markThreadViewed: (threadId) => rpc<void>("thread.markViewed", { threadId }),
    syncThreadPrs: (workspaceId) =>
      rpc<Array<{ threadId: string; prNumber: number; prStatus: string }>>("thread.syncPrs", { workspaceId }),

    // Git
    listBranches: (workspaceId) => rpc<GitBranch[]>("git.listBranches", { workspaceId }),
    getCurrentBranch: (workspaceId) => rpc<string>("git.currentBranch", { workspaceId }),
    checkoutBranch: (workspaceId, branch) =>
      rpc<void>("git.checkout", { workspaceId, branch }),
    listWorktrees: (workspaceId) => rpc<WorktreeInfo[]>("git.listWorktrees", { workspaceId }),

    // Agent
    sendMessage: (threadId, content, model?, permissionMode?: PermissionMode, attachments?: AttachmentMeta[], reasoningLevel?: ReasoningLevel, provider?: string, interactionMode?) =>
      rpc<void>("agent.send", { threadId, content, model, permissionMode, attachments, reasoningLevel, provider, interactionMode }),
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
      provider?,
      interactionMode?,
      parentThreadId?,
      forkedFromMessageId?,
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
        provider,
        interactionMode,
        parentThreadId,
        forkedFromMessageId,
      }),
    stopAgent: (threadId) => rpc<void>("agent.stop", { threadId }),
    answerPlanQuestions: (threadId, answers, permissionMode?, reasoningLevel?) =>
      rpc<void>("agent.answerQuestions", { threadId, answers, permissionMode, reasoningLevel }),
    readClipboardImage: () =>
      Promise.resolve(null as AttachmentMeta | null),
    saveClipboardFile: (data, mimeType, fileName) =>
      rpcBinary<AttachmentMeta | null>("clipboard.saveFile", { mimeType, fileName }, data),
    getActiveAgentCount: () => rpc<number>("agent.activeCount", {}),

    // Messages
    getMessages: (threadId, limit, before?) =>
      rpc<PaginatedMessages>("message.list", { threadId, limit, ...(before != null ? { before } : {}) }),

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
    getSnapshotDiffStats: (snapshotId) =>
      rpc<{ filePath: string; additions: number; deletions: number }[]>(
        "snapshot.getDiffStats",
        { snapshotId },
      ),
    cleanupSnapshots: () =>
      rpc<{ removed: number }>("snapshot.cleanup", {}),
    listSnapshots: (threadId) =>
      rpc<TurnSnapshot[]>("snapshot.listByThread", { threadId }),
    getCumulativeDiff: (threadId, filePath?, maxLines?) =>
      rpc<string>("snapshot.getCumulativeDiff", { threadId, filePath, maxLines }),
    getGitLog: (workspaceId, branch?, limit?, baseBranch?, threadId?) =>
      rpc<GitCommit[]>("git.log", { workspaceId, branch, limit, baseBranch, threadId }),
    getCommitDiff: (workspaceId, sha, filePath?, maxLines?) =>
      rpc<string>("git.commitDiff", { workspaceId, sha, filePath, maxLines }),
    getCommitFiles: (workspaceId, sha) =>
      rpc<string[]>("git.commitFiles", { workspaceId, sha }),

    // GitHub PR (advanced)
    push: (workspaceId, branch) =>
      rpc<{ success: boolean }>("git.push", { workspaceId, branch }),

    generatePrDraft: (workspaceId, threadId, baseBranch) =>
      rpc<PrDraft>("github.generatePrDraft", {
        workspaceId,
        threadId,
        baseBranch,
      }),

    createPr: (workspaceId, threadId, title, body, baseBranch, isDraft) =>
      rpc<CreatePrResult>("github.createPr", {
        workspaceId,
        threadId,
        title,
        body,
        baseBranch,
        isDraft,
      }),

    // Settings
    getSettings: () => rpc<Settings>("settings.get", {}),
    updateSettings: (partial) => rpc<Settings>("settings.update", partial as Record<string, unknown>),

    // Provider models
    listProviderModels: (providerId) =>
      rpc<ProviderModelInfo[]>("provider.listModels", { providerId }),
    getProviderUsage: (providerId) =>
      rpc<ProviderUsageInfo>("provider.getUsage", { providerId }),

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
