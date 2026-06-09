// Import shared types for local use in the McodeTransport interface.
import type {
  Workspace,
  WorkspaceEnrichment,
  Thread,
  RecentThread,
  PaginatedMessages,
  AttachmentMeta,
  GitBranch,
  WorktreeInfo,
  PrInfo,
  PrDetail,
  SkillInfo,
  SkillDiagnostics,
  PermissionMode,
  ReasoningLevel,
  ContextWindowMode,
  ToolCallRecord,
  ThoughtSegmentRecord,
  HookExecutionRecord,
  TurnSnapshot,
  Settings,
  PartialSettings,
  GitCommit,
  PlanAnswer,
  InteractionMode,
  PlanAction,
  ProviderModelInfo,
  ProviderUsageInfo,
  ProviderAvailability,
  PrDraft,
  CreatePrResult,
  ChecksStatus,
  CopilotSubagent,
  PermissionDecision,
  PermissionRequest,
  CreateAndSendResult,
} from "@mcode/contracts";

// Re-export shared types from the contracts package (single source of truth).
export type {
  Workspace,
  WorkspaceEnrichment,
  Thread,
  RecentThread,
  Message,
  AttachmentMeta,
  StoredAttachment,
  GitBranch,
  WorktreeInfo,
  PrInfo,
  PrDetail,
  SkillInfo,
  SkillDiagnostics,
  PermissionMode,
  InteractionMode,
  ContextWindowMode,
  Settings,
  PartialSettings,
  GitCommit,
  PlanAnswer,
  PlanAction,
  ProviderModelInfo,
} from "@mcode/contracts";

export type { PaginatedMessages, ToolCallRecord, ThoughtSegmentRecord, HookExecutionRecord, TurnSnapshot, CopilotSubagent } from "@mcode/contracts";

export { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts";

/** In-progress tool call tracked by the frontend streaming layer. */
export interface ToolCall {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  output: string | null;
  isError: boolean;
  isComplete: boolean;
  /** ID of the parent Agent tool call, if this is a subagent child. */
  parentToolCallId?: string;
  /** Elapsed wall-clock seconds reported by the most recent toolProgress event. */
  elapsedSeconds?: number;
  /** Epoch ms when the toolUse event was received, used for duration display. */
  startedAt?: number;
  /** Wall-clock duration when the tool call completed (ms). */
  durationMs?: number;
}

/** Ephemeral hook execution state tracked during a session. Not persisted to DB. */
export interface HookExecution {
  hookName: string;
  hookType: "permission" | "stop";
  toolName?: string;
  status: "running" | "completed";
  /** Last 20 lines of hook output, shown by default in the UI. */
  outputLines: string[];
  /** Full hook output buffer, available via "show all" toggle. */
  fullOutput: string[];
  exitCode?: number;
  durationMs?: number;
  didBlock?: boolean;
  /** Timestamp when the hook started, used to derive an elapsed timer. */
  startedAt: number;
}

/** Category of an openable app, mirroring the desktop registry's adapter kinds. */
export type OpenInAppKind = "editor" | "fileManager";

/**
 * Openable-app metadata as exposed by the desktop main-process registry. Icons
 * cannot cross the IPC boundary, so the registry supplies an {@link OpenInApp.iconKey}
 * the renderer maps to a component.
 */
export interface OpenInApp {
  /** Stable identifier used to dispatch launches (e.g. "code", "explorer"). */
  readonly id: string;
  /** Human-readable name shown in the menu (e.g. "VS Code"). */
  readonly label: string;
  /** App category, driving launch semantics and menu grouping. */
  readonly kind: OpenInAppKind;
  /** Renderer-side key for the app's icon component. */
  readonly iconKey: string;
  /** Whether the app is installed / available on this system. */
  readonly detected: boolean;
}

/**
 * What an {@link McodeTransport.openIn} call should open. `line` is honored only
 * by editor-kind apps with a file target; other apps ignore it. Mirrors the
 * desktop registry's launch target.
 */
export interface OpenInTarget {
  /** Absolute path to open (file or directory). */
  readonly path: string;
  /** Optional 1-based line to jump to (editor + file target only). */
  readonly line?: number;
}

/** Transport interface consumed by the web app to communicate with the backend. */
export interface McodeTransport {
  // Workspace commands
  createWorkspace(name: string, path: string): Promise<Workspace>;
  listWorkspaces(): Promise<Workspace[]>;
  deleteWorkspace(id: string): Promise<boolean>;
  /** Record workspace as last-opened for recency ordering in the project selector. */
  touchLastOpened(id: string): Promise<void>;
  /** Pin or unpin a workspace in the project selector. */
  pinWorkspace(id: string, pinned: boolean): Promise<void>;
  /** Remove a workspace from the recents list and unpin it. */
  removeRecent(id: string): Promise<void>;
  /** Persist sidebar index for a workspace after drag-and-drop (zero-based). */
  reorderWorkspace(id: string, newIndex: number): Promise<void>;
  /** Batch-fetch git branch, cleanliness, and thread count for the given workspace ids. */
  enrichWorkspaces(ids: string[]): Promise<{ items: WorkspaceEnrichment[] }>;
  /** Browse the host filesystem at the given path. Returns entries and parent path. */
  filesystemBrowse(path: string): Promise<{
    path: string;
    parent: string | null;
    entries: { name: string; isDir: boolean }[];
  }>;

  // Thread commands
  createThread(
    workspaceId: string,
    title: string,
    mode: "direct" | "worktree",
    branch: string,
  ): Promise<Thread>;
  listThreads(workspaceId: string): Promise<Thread[]>;
  /** List the most recently active threads across all workspaces, joined with workspace name + path. */
  listRecentThreads(limit?: number): Promise<RecentThread[]>;
  /** Search threads across all workspaces by title, with optional status/provider filters. */
  searchThreads(opts: {
    query: string;
    filters?: { status?: string[]; provider?: string[] };
    sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
    limit?: number;
  }): Promise<{ threads: Thread[]; workspaces: { id: string; name: string; path: string }[] }>;
  deleteThread(threadId: string, cleanupWorktree: boolean): Promise<boolean>;

  // Git branch commands
  listBranches(workspaceId: string): Promise<GitBranch[]>;
  getCurrentBranch(workspaceId: string): Promise<string | null>;
  checkoutBranch(workspaceId: string, branch: string): Promise<void>;
  listWorktrees(workspaceId: string): Promise<WorktreeInfo[]>;

  // Agent commands
  sendMessage(
    threadId: string,
    content: string,
    model?: string,
    permissionMode?: PermissionMode,
    attachments?: AttachmentMeta[],
    displayContent?: string,
    reasoningLevel?: ReasoningLevel,
    provider?: string,
    interactionMode?: InteractionMode,
    copilotAgent?: string,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
    codexFastMode?: boolean,
    replyToMessageId?: string,
    quotedText?: string,
    planAction?: PlanAction,
  ): Promise<void>;
  createAndSendMessage(
    workspaceId: string,
    content: string,
    model: string,
    permissionMode?: PermissionMode,
    mode?: "direct" | "worktree",
    branch?: string,
    existingWorktreePath?: string,
    attachments?: AttachmentMeta[],
    reasoningLevel?: ReasoningLevel,
    provider?: string,
    interactionMode?: InteractionMode,
    parentThreadId?: string,
    forkedFromMessageId?: string,
    copilotAgent?: string,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
    codexFastMode?: boolean,
    displayContent?: string,
  ): Promise<CreateAndSendResult>;
  stopAgent(threadId: string): Promise<void>;
  /** Respond to a tool permission request from the agent. */
  respondToPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  /** List pending permission requests for a thread (used to re-hydrate after reconnect). */
  listPendingPermissions(threadId: string): Promise<PermissionRequest[]>;
  /** Submit answers to a plan-mode question batch and resume the agent session. */
  answerPlanQuestions(
    threadId: string,
    answers: PlanAnswer[],
    permissionMode?: PermissionMode,
    reasoningLevel?: ReasoningLevel,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
  ): Promise<void>;
  /**
   * Durably dismiss the latest plan-questions batch for a thread.
   * The server marks the batch as settled and broadcasts plan.answered;
   * the wizard does NOT re-appear on subsequent reloads.
   */
  dismissPlanQuestions(threadId: string): Promise<void>;
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Save a clipboard file blob to disk via the server. Returns attachment metadata. */
  saveClipboardFile(data: ArrayBuffer, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
  getActiveAgentCount(): Promise<number>;
  /**
   * Returns the thread IDs with live agent sessions on the server.
   * Called on WebSocket (re)connect to reconcile runningThreadIds after the
   * optimistic client-side set was lost (reload, new tab, reconnect).
   */
  listRunning(): Promise<string[]>;

  // Thread mutations
  updateThreadTitle(threadId: string, title: string): Promise<boolean>;
  /** Persist per-thread composer settings (reasoning, mode, permission, copilot agent, context window, thinking). */
  updateThreadSettings(
    threadId: string,
    settings: {
      reasoningLevel?: ReasoningLevel;
      interactionMode?: InteractionMode;
      permissionMode?: PermissionMode;
      copilotAgent?: string | null;
      contextWindow?: ContextWindowMode | null;
      thinking?: boolean | null;
      codexFastMode?: boolean | null;
    },
  ): Promise<boolean>;
  /** Clear the "completed" badge for a thread. Transitions completed -> paused in the DB. */
  markThreadViewed(threadId: string): Promise<void>;
  /** Scan threads for stale or missing PR data and refresh their state. Returns updated PR state
   * for all affected threads. A null prNumber/prStatus signals the PR was cleared (stale data removed). */
  syncThreadPrs(workspaceId: string): Promise<Array<{ threadId: string; prNumber: number | null; prStatus: string | null }>>;

  // Message queries
  /**
   * Fetch persisted messages for a thread, ordered by sequence ascending.
   * @param threadId - Thread to fetch messages from.
   * @param limit - Maximum number of messages to return.
   * @param before - Optional sequence cursor; when provided, only messages with
   *   `sequence < before` are returned, enabling backward pagination.
   *   Omit to fetch the most recent messages.
   * @returns Paginated response with messages array and hasMore flag.
   */
  getMessages(threadId: string, limit: number, before?: number): Promise<PaginatedMessages>;

  // Config
  discoverConfig(workspacePath: string): Promise<Record<string, unknown>>;

  // Meta
  getVersion(): Promise<string>;

  // File operations (@ file tagging)
  listWorkspaceFiles(workspaceId: string, threadId?: string): Promise<string[]>;
  readFileContent(workspaceId: string, relativePath: string, threadId?: string): Promise<string>;

  // Open-in app actions
  /**
   * List openable apps (editors, file manager) with metadata and detection
   * status, sourced from the desktop main-process registry. Returns an empty
   * list when no desktop bridge is present (web build).
   */
  listOpenInApps(): Promise<OpenInApp[]>;
  /**
   * Open a target in the app identified by `appId`. The desktop registry
   * dispatches to that app's adapter, so the same call opens an editor or
   * reveals a path in the file manager depending on the app. `appId` values
   * come from {@link McodeTransport.listOpenInApps}. No-op when no desktop
   * bridge is present (web build).
   */
  openIn(args: { appId: string; target: OpenInTarget }): Promise<void>;

  // GitHub PR
  getBranchPr(branch: string, cwd: string): Promise<PrInfo | null>;

  // PR review
  listOpenPrs(workspaceId: string): Promise<PrDetail[]>;
  fetchBranch(workspaceId: string, branch: string, prNumber?: number): Promise<void>;
  getPrByUrl(url: string): Promise<PrDetail | null>;
  /** Fetch fresh CI check status for a thread (manual refresh). */
  checkStatus(threadId: string, force?: boolean): Promise<ChecksStatus>;

  // Skills
  /** List discoverable skills and commands, optionally scoped to a workspace path and provider. */
  listSkills(cwd?: string, providerId?: string): Promise<SkillInfo[]>;
  /** Run a filesystem scan across all skill search paths and return per-path diagnostics. */
  diagnoseSkills(cwd?: string): Promise<SkillDiagnostics>;

  // Terminal (PTY)
  /** Create a new PTY attached to a thread's working directory. Returns the pty ID and shell name. */
  terminalCreate(threadId: string): Promise<{ ptyId: string; shell: string }>;
  /** Write data (keystrokes) to a PTY. */
  terminalWrite(ptyId: string, data: string): Promise<void>;
  /** Resize a PTY to the given dimensions. */
  terminalResize(ptyId: string, cols: number, rows: number): Promise<void>;
  /** Kill a single PTY by ID. */
  terminalKill(ptyId: string): Promise<void>;
  /** Request the server to stop draining a PTY. Idempotent. */
  terminalPause(ptyId: string): Promise<void>;
  /** Request the server to resume a paused PTY. Idempotent. */
  terminalResume(ptyId: string): Promise<void>;
  /** Kill all PTYs attached to a thread. */
  terminalKillByThread(threadId: string): Promise<void>;
  /**
   * Reattach to a PTY after a WebSocket reconnect.
   * The server replays any buffered output with seq > lastSeq as binary frames
   * before returning. Returns gapped=true when eviction means output was lost.
   */
  terminalReattach(ptyId: string, lastSeq: number): Promise<{ gapped: boolean }>;
  /** List all active PTY sessions on the server. Used during reconnect. */
  terminalListActive(): Promise<Array<{ ptyId: string; threadId: string }>>;
  /** Check whether a PTY has non-shell child processes running. */
  terminalHasChildren(ptyId: string): Promise<{ hasChildren: boolean }>;
  /** Track the last seq number received for a PTY, used during reconnect reattach. */
  ptySetLastSeq(ptyId: string, seq: number): void;
  /** Remove the last-seq tracking entry for a PTY. Call on component unmount. */
  ptyDeleteLastSeq(ptyId: string): void;

  // Tool call records
  /** Fetch persisted tool call records for a message. */
  listToolCallRecords(messageId: string): Promise<ToolCallRecord[]>;
  /** Fetch child tool call records for a parent tool call. */
  listToolCallRecordsByParent(parentToolCallId: string): Promise<ToolCallRecord[]>;
  /** Fetch the full persisted narrative (tools, thoughts, hooks) for an assistant message. */
  listNarrative(messageId: string): Promise<{
    tools: ToolCallRecord[];
    thoughts: ThoughtSegmentRecord[];
    hooks: HookExecutionRecord[];
  }>;
  /** Fetch a thread's full server-ordered narrative as a flat, chronological list. */
  loadTurn(threadId: string): Promise<import("@mcode/contracts").NarrativeEntry[]>;

  /** Fetch persisted task list for a thread (from last TodoWrite). */
  getThreadTasks(threadId: string): Promise<Array<{ content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; group?: string }> | null>;

  /** Fetch persisted plans for a thread (hydration on page load). */
  getThreadPlans(threadId: string): Promise<import("@mcode/contracts").PlanRecord[]>;

  // Snapshots
  /** Get a unified diff for a specific file from a turn snapshot. */
  getSnapshotDiff(snapshotId: string, filePath?: string, maxLines?: number): Promise<string>;
  /** Get per-file addition/deletion counts for a turn snapshot. */
  getSnapshotDiffStats(snapshotId: string): Promise<{ filePath: string; additions: number; deletions: number }[]>;
  /** Run garbage collection on expired snapshot refs. */
  cleanupSnapshots(): Promise<{ removed: number }>;
  /** List all turn snapshots for a thread, ordered by creation time. */
  listSnapshots(threadId: string): Promise<TurnSnapshot[]>;
  /** Get cumulative diff across all turns for a thread. Implemented in Phase 3. */
  getCumulativeDiff(threadId: string, filePath?: string, maxLines?: number): Promise<string>;
  /** Get commit log for a workspace branch. Pass threadId so the server runs git from the thread's worktree path. */
  getGitLog(workspaceId: string, branch?: string, limit?: number, baseBranch?: string, threadId?: string): Promise<GitCommit[]>;
  /** Get unified diff for a specific git commit. Implemented in Phase 4. */
  getCommitDiff(workspaceId: string, sha: string, filePath?: string, maxLines?: number): Promise<string>;
  /** Get the list of files changed in a specific git commit. */
  getCommitFiles(workspaceId: string, sha: string): Promise<string[]>;

  // GitHub PR (advanced)
  /** Push a branch to the remote. */
  push(workspaceId: string, branch: string): Promise<{ success: boolean }>;

  /** Generate an AI-powered PR draft from commit history and conversation context. */
  generatePrDraft(workspaceId: string, threadId: string, baseBranch: string): Promise<PrDraft>;

  /** Push the branch (if needed) and create a GitHub PR. */
  createPr(
    workspaceId: string,
    threadId: string,
    title: string,
    body: string,
    baseBranch: string,
    isDraft: boolean,
  ): Promise<CreatePrResult>;

  // Settings
  /** Fetch the full settings object from the server. */
  getSettings(): Promise<Settings>;
  /** Update settings with a deep-partial merge. Returns full merged settings. */
  updateSettings(partial: PartialSettings): Promise<Settings>;

  // Provider models
  /** Fetch dynamically discovered models from a provider (e.g. Copilot). */
  listProviderModels(providerId: string): Promise<ProviderModelInfo[]>;
  /** Fetch current usage/quota state for a provider. */
  getProviderUsage(providerId: string): Promise<ProviderUsageInfo>;
  /** Fetches Copilot sub-agents available for the given workspace. */
  listCopilotAgents(workspaceId: string): Promise<CopilotSubagent[]>;
  /** Fetch the current availability snapshot for all registered providers. */
  listProviderAvailability(): Promise<ProviderAvailability[]>;

  // Diff summaries
  /** Fetch the stored diff summary for a thread, or null if none exists. */
  getDiffSummary(threadId: string): Promise<{
    id: string;
    threadId: string;
    content: string;
    turnCount: number;
    lastTurnId: string | null;
    model: string;
    createdAt: string;
  } | null>;
  /** Generate (or regenerate) an AI-powered diff summary for a thread. */
  generateDiffSummary(threadId: string): Promise<{
    id: string;
    threadId: string;
    content: string;
    turnCount: number;
    lastTurnId: string | null;
    model: string;
    createdAt: string;
  }>;

  // Memory pressure
  /** Notify server of window background/foreground state for memory management. */
  setBackground(background: boolean): Promise<void>;

  /**
   * Read the latest handoff artifact for a child thread.
   * Returns null when no handoff has been written for the thread.
   */
  readLatestHandoff(threadId: string): Promise<{
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
  } | null>;
}
