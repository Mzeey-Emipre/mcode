import type {
  McodeTransport,
  Workspace,
  WorkspaceEnrichment,
  Thread,
  GitBranch,
  BranchComparison,
  WorktreeInfo,
  AttachmentMeta,
  SkillInfo,
  SkillDiagnostics,
  PrInfo,
  PrDetail,
  PermissionMode,
  ToolCallRecord,
  ThoughtSegmentRecord,
  HookExecutionRecord,
  Settings,
  GitCommit,
  ProviderModelInfo,
  CopilotSubagent,
  CodexAgentMentionInfo,
  GitRemoteUrl,
} from "./types";
import type {
  CreateAndSendResult,
  PullRequestCapabilitiesRequest,
  PullRequestCapabilitiesResult,
  PullRequestListRequest,
  PullRequestListResult,
  PullRequestGetRequest,
  PullRequestGetResult,
  PullRequestTimelineRequest,
  PullRequestTimelineResult,
  PullRequestFilesRequest,
  PullRequestFilesResult,
  PullRequestPatchRequest,
  PullRequestPatchResult,
  PullRequestCancelRequest,
  PullRequestCancelResult,
  PullRequestCreateReviewTaskRequest,
  PullRequestCreateReviewTaskResult,
  PullRequestReviewLinkRequest,
  PullRequestReviewLinkResult,
  PullRequestPostCommentRequest,
  PullRequestPostCommentResult,
  PullRequestSubmitReviewRequest,
  PullRequestSubmitReviewResult,
  PullRequestSetReadinessRequest,
  PullRequestSetReadinessResult,
  PullRequestCloseRequest,
  PullRequestCloseResult,
  PullRequestMergeRequest,
  PullRequestMergeResult,
} from "@mcode/contracts";
import { emitPtyReconnectGap } from "@/components/terminal/ptyDataRegistry";
import type { PaginatedMessages, ConversationPage, TurnSnapshot, PrDraft, CreatePrResult, ProviderUsageInfo, ChecksStatus, ProviderAvailability, GoalLookupResult } from "@mcode/contracts";
import type { ReasoningLevel } from "@mcode/contracts";
import {
  TERMINAL_DATA_TAG,
  decodeTerminalDataFrame,
} from "@mcode/contracts";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadStore } from "@/stores/threadStore";
import type { PermissionRequest } from "@mcode/contracts";
import { setAttachmentTransportWsUrl } from "@/lib/attachment-url";

/** Minimum reconnect delay in milliseconds. */
const MIN_RECONNECT_MS = 1000;
/** Maximum reconnect delay in milliseconds. */
const MAX_RECONNECT_MS = 30_000;
/** Number of immediate (delay=0) retries on auth failure before falling back to exponential backoff. */
const MAX_IMMEDIATE_AUTH_RETRIES = 3;

/** Last thread-list refresh timestamp per workspace, triggered on WS reconnect. */
const lastLoadThreadsAtByWorkspace = new Map<string, number>();
/** Minimum interval between reconnect-triggered thread-list fetches to avoid rapid-reconnect storms. */
const LOAD_THREADS_RECONNECT_COOLDOWN_MS = 5_000;

/** Minimum interval between desktop ensure-server-running requests. */
const ENSURE_SERVER_THROTTLE_MS = 15_000;
/** Timestamp of the last ensure-server-running request (module-level: one server per app). */
let lastEnsureServerAt = 0;

/**
 * Ask the Electron main process to verify (and silently restart) the server.
 * Throttled so rapid reconnect attempts do not stack health checks. No-op in
 * browser builds where `desktopBridge` is absent.
 *
 * Returns whether a request was actually issued. Exported for unit testing.
 */
export function requestEnsureServerRunning(now: number = Date.now()): boolean {
  if (now - lastEnsureServerAt < ENSURE_SERVER_THROTTLE_MS) return false;
  lastEnsureServerAt = now;
  if (typeof window === "undefined") return false;
  void window.desktopBridge?.ensureServerRunning?.()?.catch(() => {
    // Best-effort: reconnect backoff continues regardless.
  });
  return true;
}

/** Reset the ensure-server throttle. Test-only. */
export function resetEnsureServerThrottleForTest(): void {
  lastEnsureServerAt = 0;
}

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

/**
 * Last seq number seen per ptyId.
 * Updated by TerminalView on each received PTY data frame and read by the
 * reconnect handler to call terminal.reattach with the correct lastSeq.
 */
export const ptyLastSeqMap = new Map<string, number>();

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** Describes the current state of the WebSocket connection. */
export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "authFailed";

/** Options for configuring `createWsTransport` behavior. */
export interface WsTransportOptions {
  /** Called whenever the connection status changes. */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Called between reconnect attempts to refresh the server URL. */
  discoverServerUrl?: () => Promise<string>;
}

/**
 * Reconcile runningThreadIds with the server's authoritative set on (re)connect.
 *
 * Race-safe: captures the optimistic runningThreadIds before the RPC and
 * preserves any threadIds added concurrently (e.g., by a session.turnStarted
 * push that arrives while the RPC is in flight). Stale threadIds from before
 * the RPC are dropped; the server's list is the source of truth for those.
 *
 * Exported for unit testing.
 */
export async function hydrateRunningThreadsFromServer(
  rpcCall: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  try {
    const beforeRpc = new Set(useThreadStore.getState().runningThreadIds);
    const ids = (await rpcCall("agent.listRunning", {})) as string[];
    const current = useThreadStore.getState().runningThreadIds;
    // Preserve threadIds added concurrently while the RPC was in flight
    // (e.g., session.turnStarted push during the round-trip).
    const concurrentAdds = [...current].filter((id) => !beforeRpc.has(id));
    useThreadStore.getState().hydrateRunningThreads([...ids, ...concurrentAdds]);
  } catch {
    // Best-effort; optimistic state remains if the call fails.
  }
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
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnectDelay = MIN_RECONNECT_MS;
      consecutiveAuthFailures = 0;
      setAttachmentTransportWsUrl(url);
      resolveReady();
      options?.onStatusChange?.("connected");

      // Reconcile runningThreadIds with the server's authoritative set.
      // The client-side optimistic Set is lost on reload/reconnect; this
      // restores live-session indicators for threads the server is still running.
      const hydration = hydrateRunningThreadsFromServer((method, params) => rpc(method, params as Record<string, unknown>));

      // Expose a sentinel in dev/test builds so Playwright can synchronize on
      // hydration completion before injecting agent events. Without this, tests
      // that call handleAgentEvent too early see their optimistic threadIds
      // classified as "pre-hydration" state and wiped by the server's response.
      if (import.meta.env.DEV && typeof window !== "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__mcodeHydrationComplete = false;
        hydration.finally(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__mcodeHydrationComplete = true;
        });
      }

      // Re-fetch the thread list after reconnect so thread statuses are not
      // stale. A server restart marks active threads "interrupted" in the DB
      // but the client still holds the pre-restart status in memory.
      // Throttled to avoid hammering the API during rapid reconnect cycles
      // (e.g. flaky networks, server restarts causing multiple reconnect attempts).
      // Deferred import avoids a circular dependency at module evaluation time.
      const nowForThreads = Date.now();
      import("@/stores/workspaceStore").then(({ useWorkspaceStore }) => {
        const { activeWorkspaceId, loadThreads } = useWorkspaceStore.getState();
        if (!activeWorkspaceId) return;
        const last = lastLoadThreadsAtByWorkspace.get(activeWorkspaceId) ?? 0;
        if (nowForThreads - last <= LOAD_THREADS_RECONNECT_COOLDOWN_MS) return;
        lastLoadThreadsAtByWorkspace.set(activeWorkspaceId, nowForThreads);
        loadThreads(activeWorkspaceId).catch(() => {});
      });

      // Reattach active terminals after reconnect.
      // Deferred import avoids a circular dependency at module evaluation time.
      import("@/stores/terminalStore").then(async ({ useTerminalStore }) => {
        try {
          const activePtys = await rpc<Array<{ ptyId: string; threadId: string }>>(
            "terminal.listActive",
            {},
          );
          useTerminalStore.getState().reconcileActiveSessions(activePtys);

          const clientPtyIds = new Set(
            Object.values(useTerminalStore.getState().terminals)
              .flat()
              .map((t) => t.id),
          );

          await Promise.allSettled(
            activePtys
              .filter((p) => clientPtyIds.has(p.ptyId))
              .map(async (p) => {
                // -1 means "I have seen nothing" — server replays everything including seq=0.
                const lastSeq = ptyLastSeqMap.get(p.ptyId) ?? -1;
                const { gapped } = await rpc<{ gapped: boolean }>(
                  "terminal.reattach",
                  { ptyId: p.ptyId, lastSeq },
                );
                if (gapped) {
                  emitPtyReconnectGap({ ptyId: p.ptyId });
                }
              }),
          );
        } catch {
          // Best-effort; terminal output from the gap window is already lost.
        }
      });
    };

    ws.onmessage = (event) => {
      // Binary frame: only terminal.data uses binary frames. The tag byte
      // identifies the frame type so future binary channels can coexist.
      if (event.data instanceof ArrayBuffer) {
        const view = new Uint8Array(event.data);
        if (view[0] === TERMINAL_DATA_TAG) {
          try {
            const decoded = decodeTerminalDataFrame(view);
            if (!suppressedPushChannels.has("terminal.data")) {
              pushEmitter.emit("terminal.data", decoded);
            }
          } catch (err) {
            console.warn("[ws] failed to decode terminal.data frame", err);
          }
        } else {
          console.warn("[ws] unknown binary tag 0x" + view[0]?.toString(16));
        }
        return;
      }

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
        options?.onStatusChange?.(isAuthFailure ? "authFailed" : "reconnecting");
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

    // Non-auth disconnects may mean the server died (e.g. killed during OS
    // sleep). Ask the desktop main process to health-check and self-heal it;
    // throttled so backoff retries do not stack requests.
    if (!immediate) {
      requestEnsureServerRunning();
    }

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
    renameWorkspace: (id, name) => rpc<Workspace>("workspace.rename", { id, name }),
    deleteWorkspace: (id) => rpc<boolean>("workspace.delete", { id }),
    touchLastOpened: (id) => rpc<void>("workspace.touchLastOpened", { id }),
    reorderWorkspace: (id, newIndex) =>
      rpc<void>("workspace.reorder", { id, newIndex }),
    pinWorkspace: (id, pinned) => rpc<void>("workspace.pin", { id, pinned }),
    removeRecent: (id) => rpc<void>("workspace.removeRecent", { id }),
    enrichWorkspaces: (ids) =>
      rpc<{ items: WorkspaceEnrichment[] }>("workspace.enrich", { ids }),
    filesystemBrowse: (path) =>
      rpc<{
        path: string;
        parent: string | null;
        entries: { name: string; isDir: boolean }[];
        isExactDirectory: boolean;
      }>(
        "filesystem.browse",
        { path },
      ),

    // Thread
    createThread: (workspaceId, title, mode, branch) =>
      rpc<Thread>("thread.create", { workspaceId, title, mode, branch }),
    listThreads: (workspaceId) => rpc<Thread[]>("thread.list", { workspaceId }),
    listRecentThreads: (limit) =>
      rpc<import("./types").RecentThread[]>("thread.recent", limit !== undefined ? { limit } : {}),
    searchThreads: (opts) =>
      rpc<{ threads: Thread[]; workspaces: { id: string; name: string; path: string }[] }>(
        "thread.search",
        {
          query: opts.query,
          filters: opts.filters,
          sort: opts.sort,
          limit: opts.limit,
        },
      ),
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
        copilotAgent: settings.copilotAgent,
        contextWindow: settings.contextWindow,
        thinking: settings.thinking,
        codexFastMode: settings.codexFastMode,
        defaultOpenInApp: settings.defaultOpenInApp,
      }),
    markThreadViewed: (threadId) => rpc<void>("thread.markViewed", { threadId }),
    syncThreadPrs: (workspaceId) =>
      rpc<Array<{ threadId: string; prNumber: number; prStatus: string }>>("thread.syncPrs", { workspaceId }),

    // Git
    listBranches: (workspaceId) => rpc<GitBranch[]>("git.listBranches", { workspaceId }),
    getCurrentBranch: (workspaceId) => rpc<string | null>("git.currentBranch", { workspaceId }),
    checkoutBranch: (workspaceId, branch) =>
      rpc<void>("git.checkout", { workspaceId, branch }),
    createBranch: (workspaceId, name, threadId) =>
      rpc<{ branch: string }>("git.createBranch", {
        workspaceId,
        name,
        ...(threadId ? { threadId } : {}),
      }),
    listWorktrees: (workspaceId) => rpc<WorktreeInfo[]>("git.listWorktrees", { workspaceId }),

    // Agent
    sendMessage: (
      threadId,
      content,
      model?,
      permissionMode?: PermissionMode,
      attachments?: AttachmentMeta[],
      displayContent?: string,
      reasoningLevel?: ReasoningLevel,
      provider?: string,
      interactionMode?,
      copilotAgent?: string,
      contextWindow?,
      thinking?,
      codexFastMode?,
      replyToMessageId?,
      quotedText?,
      planAction?,
      mentions?,
      previewAnnotations?,
      goalObjective?,
    ) => {
      const state = useSettingsStore.getState();
      const guardrails = state.loaded
        ? { maxBudgetUsd: state.settings.agent.guardrails.maxBudgetUsd, maxTurns: state.settings.agent.guardrails.maxTurns }
        : {};
      return rpc<void>("agent.send", {
        threadId,
        content,
        model,
        permissionMode,
        attachments,
        reasoningLevel,
        provider,
        interactionMode,
        copilotAgent,
        contextWindow,
        thinking,
        ...(codexFastMode !== undefined && { codexFastMode }),
        ...(replyToMessageId && { replyToMessageId }),
        ...(quotedText && { quotedText }),
        ...(displayContent !== undefined && { displayContent }),
        ...(planAction !== undefined && { planAction }),
        ...(mentions !== undefined && { mentions }),
        ...(previewAnnotations !== undefined && { previewAnnotations }),
        ...(goalObjective !== undefined && { goalObjective }),
        ...guardrails,
      });
    },
    createAndSendMessage: (
      workspaceId,
      content,
      model,
      permissionMode?,
      mode?,
      branch?,
      worktreeBranchMode?,
      existingWorktreePath?,
      existingWorktreeBaseBranch?,
      attachments?,
      reasoningLevel?,
      provider?,
      interactionMode?,
      parentThreadId?,
      forkedFromMessageId?,
      copilotAgent?,
      contextWindow?,
      thinking?,
      codexFastMode?,
      displayContent?,
      mentions?,
      previewAnnotations?,
      goalObjective?,
    ) => {
      const state = useSettingsStore.getState();
      const guardrails = state.loaded
        ? { maxBudgetUsd: state.settings.agent.guardrails.maxBudgetUsd, maxTurns: state.settings.agent.guardrails.maxTurns }
        : {};
      return rpc<CreateAndSendResult>("agent.createAndSend", {
        workspaceId,
        content,
        model,
        permissionMode,
        mode,
        branch,
        worktreeBranchMode,
        existingWorktreePath,
        existingWorktreeBaseBranch,
        attachments,
        reasoningLevel,
        provider,
        interactionMode,
        parentThreadId,
        forkedFromMessageId,
        copilotAgent,
        contextWindow,
        thinking,
        ...(codexFastMode !== undefined && { codexFastMode }),
        ...(displayContent !== undefined && { displayContent }),
        ...(mentions !== undefined && { mentions }),
        ...(previewAnnotations !== undefined && { previewAnnotations }),
        ...(goalObjective !== undefined && { goalObjective }),
        ...guardrails,
      });
    },
    stopAgent: (threadId) => rpc<void>("agent.stop", { threadId }),
    respondToPermission: (requestId, decision) =>
      rpc<void>("permission.respond", { requestId, decision }),
    listPendingPermissions: (threadId) =>
      rpc<PermissionRequest[]>("permission.listPending", { threadId }),
    answerPlanQuestions: (threadId, answers, permissionMode?, reasoningLevel?, contextWindow?, thinking?) =>
      rpc<void>("agent.answerQuestions", { threadId, answers, permissionMode, reasoningLevel, contextWindow, thinking }),
    dismissPlanQuestions: (threadId) =>
      rpc<void>("agent.dismissPlanQuestions", { threadId }),
    readClipboardImage: () =>
      Promise.resolve(null as AttachmentMeta | null),
    saveClipboardFile: (data, mimeType, fileName) =>
      rpcBinary<AttachmentMeta | null>("clipboard.saveFile", { mimeType, fileName }, data),
    getActiveAgentCount: () => rpc<number>("agent.activeCount", {}),
    listRunning: () => rpc<string[]>("agent.listRunning", {}),
    subscribeThread: (threadId) => rpc<void>("push.subscribeThread", { threadId }),
    unsubscribeThread: (threadId) => rpc<void>("push.unsubscribeThread", { threadId }),
    getThreadGoal: (threadId) =>
      rpc<GoalLookupResult>("thread.goal.get", { threadId }),
    clearThreadGoal: (threadId) =>
      rpc<GoalLookupResult>("thread.goal.clear", { threadId }),

    // Messages
    getMessages: (threadId, limit, before?) =>
      rpc<PaginatedMessages>("message.list", { threadId, limit, ...(before != null ? { before } : {}) }),
    loadConversationPage: (threadId, limit, before?) =>
      rpc<ConversationPage>("conversation.page", { threadId, limit, ...(before != null ? { before } : {}) }),

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

    // Open-in apps (delegated to desktopBridge; no-op over WS)
    listOpenInApps: async () => (await window.desktopBridge?.listOpenInApps()) ?? [],
    openIn: async (appId, path, line) =>
      window.desktopBridge?.openIn(appId, path, line),

    // GitHub
    getBranchPr: (branch, cwd) =>
      rpc<PrInfo | null>("github.branchPr", { branch, cwd }),
    getPullRequestCapabilities: (request: PullRequestCapabilitiesRequest) =>
      rpc<PullRequestCapabilitiesResult>("pullRequest.capabilities", request),
    listPullRequests: (request: PullRequestListRequest) =>
      rpc<PullRequestListResult>("pullRequest.list", request),
    getPullRequestResource: (request: PullRequestGetRequest) =>
      rpc<PullRequestGetResult>("pullRequest.get", request),
    getPullRequestTimeline: (request: PullRequestTimelineRequest) =>
      rpc<PullRequestTimelineResult>("pullRequest.timeline", request),
    getPullRequestFiles: (request: PullRequestFilesRequest) =>
      rpc<PullRequestFilesResult>("pullRequest.files", request),
    getPullRequestPatch: (request: PullRequestPatchRequest) =>
      rpc<PullRequestPatchResult>("pullRequest.patch", request),
    createPullRequestReviewTask: (request: PullRequestCreateReviewTaskRequest) =>
      rpc<PullRequestCreateReviewTaskResult>("pullRequest.createReviewTask", request),
    getPullRequestReviewLink: (request: PullRequestReviewLinkRequest) =>
      rpc<PullRequestReviewLinkResult>("pullRequest.reviewLink", request),
    postPullRequestComment: (request: PullRequestPostCommentRequest) =>
      rpc<PullRequestPostCommentResult>("pullRequest.postComment", request),
    submitPullRequestReview: (request: PullRequestSubmitReviewRequest) =>
      rpc<PullRequestSubmitReviewResult>("pullRequest.submitReview", request),
    setPullRequestReadiness: (request: PullRequestSetReadinessRequest) =>
      rpc<PullRequestSetReadinessResult>("pullRequest.setReadiness", request),
    closePullRequest: (request: PullRequestCloseRequest) =>
      rpc<PullRequestCloseResult>("pullRequest.close", request),
    mergePullRequest: (request: PullRequestMergeRequest) =>
      rpc<PullRequestMergeResult>("pullRequest.merge", request),
    cancelPullRequestOperation: (request: PullRequestCancelRequest) =>
      rpc<PullRequestCancelResult>("pullRequest.cancel", request),
    listOpenPrs: (workspaceId) => rpc<PrDetail[]>("github.listOpenPrs", { workspaceId }),
    fetchBranch: (workspaceId, branch, prNumber?) =>
      rpc<void>("git.fetchBranch", { workspaceId, branch, prNumber }),
    getPrByUrl: (url) => rpc<PrDetail | null>("github.prByUrl", { url }),
    checkStatus: (threadId, force) =>
      rpc<ChecksStatus>("github.checkStatus", { threadId, force }),

    // Skills
    listSkills: (cwd?, providerId?) => rpc<SkillInfo[]>("skill.list", { cwd, providerId }),
    diagnoseSkills: (cwd?) => rpc<SkillDiagnostics>("skill.diagnose", { cwd }),

    // Terminal (PTY)
    terminalCreate: (threadId) => rpc<{ ptyId: string; shell: string }>("terminal.create", { threadId }),
    terminalWrite: (ptyId, data) => rpc<void>("terminal.write", { ptyId, data }),
    terminalResize: (ptyId, cols, rows) =>
      rpc<void>("terminal.resize", { ptyId, cols, rows }),
    terminalKill: (ptyId) => rpc<void>("terminal.kill", { ptyId }),
    terminalPause: (ptyId) => rpc<void>("terminal.pause", { ptyId }),
    terminalResume: (ptyId) => rpc<void>("terminal.resume", { ptyId }),
    terminalKillByThread: (threadId) =>
      rpc<void>("terminal.killByThread", { threadId }),
    terminalReattach: (ptyId, lastSeq) =>
      rpc<{ gapped: boolean }>("terminal.reattach", { ptyId, lastSeq }),
    terminalListActive: () =>
      rpc<Array<{ ptyId: string; threadId: string }>>("terminal.listActive", {}),
    terminalHasChildren: (ptyId) =>
      rpc<{ hasChildren: boolean }>("terminal.hasChildren", { ptyId }),
    ptySetLastSeq: (ptyId, seq) => { ptyLastSeqMap.set(ptyId, seq); },
    ptyDeleteLastSeq: (ptyId) => { ptyLastSeqMap.delete(ptyId); },

    // Tool call records
    listToolCallRecords: (messageId) =>
      rpc<ToolCallRecord[]>("toolCallRecord.list", { messageId }),
    listToolCallRecordsByParent: (parentToolCallId) =>
      rpc<ToolCallRecord[]>("toolCallRecord.listByParent", { parentToolCallId }),
    listNarrative: (messageId) =>
      rpc<{
        tools: ToolCallRecord[];
        thoughts: ThoughtSegmentRecord[];
        hooks: HookExecutionRecord[];
      }>("narrative.list", { messageId }),
    loadTurn: (threadId) =>
      rpc<import("@mcode/contracts").NarrativeEntry[]>("turn.load", { threadId }),

    // Thread tasks
    getThreadTasks: (threadId: string) =>
      rpc<Array<{ id?: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; activeForm?: string; group?: string }> | null>(
        "thread.getTasks", { threadId },
      ),

    getThreadPlans: (threadId: string) =>
      rpc<import("@mcode/contracts").PlanRecord[]>("plan.list", { threadId }),

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
    getGitLog: (workspaceId, branch?, limit?, baseBranch?, threadId?, options?) =>
      rpc<GitCommit[]>("git.log", {
        workspaceId,
        branch,
        limit,
        baseBranch,
        threadId,
        skip: options?.skip,
        includeStats: options?.includeStats,
      }),
    getCommitDiff: (workspaceId, sha, filePath?, maxLines?) =>
      rpc<string>("git.commitDiff", { workspaceId, sha, filePath, maxLines }),
    getCommitFiles: (workspaceId, sha) =>
      rpc<string[]>("git.commitFiles", { workspaceId, sha }),
    getWorkingTreeFiles: (workspaceId, staged, threadId?) =>
      rpc<string[]>("git.workingTreeFiles", { workspaceId, staged, threadId }),
    getWorkingTreeDiff: (workspaceId, staged, filePath?, maxLines?, threadId?) =>
      rpc<string>("git.workingTreeDiff", { workspaceId, staged, filePath, maxLines, threadId }),
    getBranchFiles: (workspaceId, base?, target?, threadId?) =>
      rpc<string[]>("git.branchFiles", { workspaceId, base, target, threadId }),
    getBranchDiff: (workspaceId, base?, target?, filePath?, maxLines?, threadId?) =>
      rpc<string>("git.branchDiff", { workspaceId, base, target, filePath, maxLines, threadId }),
    getBranchComparison: (workspaceId, threadId?) =>
      rpc<BranchComparison>("git.branchComparison", { workspaceId, threadId }),
    getRemoteUrl: (workspaceId, threadId?) =>
      rpc<GitRemoteUrl>("git.getRemoteUrl", { workspaceId, threadId }),
    getReviewDiffStats: (params) =>
      rpc<{ additions: number; deletions: number }>("git.reviewDiffStats", params),

    // GitHub PR (advanced)
    push: (workspaceId, branch, threadId?) =>
      rpc<{ success: boolean }>("git.push", { workspaceId, branch, threadId }),

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
    /** Fetches all available Copilot sub-agents for the given workspace (built-in + user + project). */
    listCopilotAgents: (workspaceId) =>
      rpc<CopilotSubagent[]>("provider.copilotAgents", { workspaceId }),
    listCodexAgents: (workspaceId, threadId?) =>
      rpc<CodexAgentMentionInfo[]>("provider.codexAgents", { workspaceId, threadId }),
    listProviderAvailability: () =>
      rpc<ProviderAvailability[]>("providers.listAvailability", {}),

    // Diff summaries
    getDiffSummary: (threadId: string) =>
      rpc<{
        id: string;
        threadId: string;
        content: string;
        turnCount: number;
        lastTurnId: string | null;
        model: string;
        createdAt: string;
      } | null>("diffSummary.get", { threadId }),
    generateDiffSummary: (threadId: string) =>
      rpc<{
        id: string;
        threadId: string;
        content: string;
        turnCount: number;
        lastTurnId: string | null;
        model: string;
        createdAt: string;
      }>("diffSummary.generate", { threadId }),
    generateRecap: (threadId, messages, previousRecap) =>
      rpc<{ text: string }>("recap.generate", { threadId, messages, previousRecap }),

    readLatestHandoff: (threadId: string) =>
      rpc<{
        markdown: string;
        meta: {
          schemaVersion: 1;
          parentThreadId: string;
          forkedFromMessageId: string;
          forkAnchorRole: "user" | "assistant";
          childThreadId: string;
          generatedBy: "provider" | "deterministic";
          provider: string | null;
          ladderStep: "B" | "D";
          mode: "full" | "minimal";
          generatedAt: string;
          characterCount: number;
          parentSdkSessionId: string | null;
          providerErrorOnGenerate: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | "clean" | null;
          regenerationHistory: Array<{
            at: string;
            ladderStep: "B" | "D";
            reason: "quota" | "auth" | "context-overflow" | "transient" | "fatal" | "clean" | "user-requested";
          }>;
          attachments: Array<{
            id: string;
            originalName: string;
            sha256: string;
            mime: string;
            parentMessageId: string;
          }>;
        };
      } | null>("handoff.readLatest", { threadId }),

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
