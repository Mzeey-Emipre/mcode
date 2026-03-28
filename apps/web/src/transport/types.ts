// Import shared types for local use in the McodeTransport interface.
import type {
  Workspace,
  Thread,
  Message,
  AttachmentMeta,
  GitBranch,
  WorktreeInfo,
  PrInfo,
  PrDetail,
  SkillInfo,
  PermissionMode,
  ToolCallRecord,
} from "@mcode/contracts";

// Re-export shared types from the contracts package (single source of truth).
export type {
  Workspace,
  Thread,
  Message,
  AttachmentMeta,
  StoredAttachment,
  GitBranch,
  WorktreeInfo,
  PrInfo,
  PrDetail,
  SkillInfo,
  PermissionMode,
  InteractionMode,
} from "@mcode/contracts";

export type { ToolCallRecord, TurnSnapshot } from "@mcode/contracts";

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
}

/** Transport interface consumed by the web app to communicate with the backend. */
export interface McodeTransport {
  // Workspace commands
  createWorkspace(name: string, path: string): Promise<Workspace>;
  listWorkspaces(): Promise<Workspace[]>;
  deleteWorkspace(id: string): Promise<boolean>;

  // Thread commands
  createThread(
    workspaceId: string,
    title: string,
    mode: "direct" | "worktree",
    branch: string,
  ): Promise<Thread>;
  listThreads(workspaceId: string): Promise<Thread[]>;
  deleteThread(threadId: string, cleanupWorktree: boolean): Promise<boolean>;

  // Git branch commands
  listBranches(workspaceId: string): Promise<GitBranch[]>;
  getCurrentBranch(workspaceId: string): Promise<string>;
  checkoutBranch(workspaceId: string, branch: string): Promise<void>;
  listWorktrees(workspaceId: string): Promise<WorktreeInfo[]>;

  // Agent commands
  sendMessage(threadId: string, content: string, model?: string, permissionMode?: PermissionMode, attachments?: AttachmentMeta[]): Promise<void>;
  createAndSendMessage(
    workspaceId: string,
    content: string,
    model: string,
    permissionMode?: PermissionMode,
    mode?: "direct" | "worktree",
    branch?: string,
    existingWorktreePath?: string,
    attachments?: AttachmentMeta[],
  ): Promise<Thread>;
  stopAgent(threadId: string): Promise<void>;
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Save a clipboard file blob to disk via the server. Returns attachment metadata. */
  saveClipboardFile(data: string, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
  getActiveAgentCount(): Promise<number>;

  // Thread mutations
  updateThreadTitle(threadId: string, title: string): Promise<boolean>;
  /** Clear the "completed" badge for a thread. Transitions completed -> paused in the DB. */
  markThreadViewed(threadId: string): Promise<void>;

  // Message queries
  getMessages(threadId: string, limit: number): Promise<Message[]>;

  // Config
  discoverConfig(workspacePath: string): Promise<Record<string, unknown>>;

  // Meta
  getVersion(): Promise<string>;

  // File operations (@ file tagging)
  listWorkspaceFiles(workspaceId: string, threadId?: string): Promise<string[]>;
  readFileContent(workspaceId: string, relativePath: string, threadId?: string): Promise<string>;

  // Editor actions
  detectEditors(): Promise<string[]>;
  openInEditor(editor: string, dirPath: string): Promise<void>;
  openInExplorer(dirPath: string): Promise<void>;

  // GitHub PR
  getBranchPr(branch: string, cwd: string): Promise<PrInfo | null>;

  // PR review
  listOpenPrs(workspaceId: string): Promise<PrDetail[]>;
  fetchBranch(workspaceId: string, branch: string, prNumber?: number): Promise<void>;
  getPrByUrl(url: string): Promise<PrDetail | null>;

  // Skills
  listSkills(cwd?: string): Promise<SkillInfo[]>;

  // Terminal (PTY)
  /** Create a new PTY attached to a thread's working directory. Returns the pty ID. */
  terminalCreate(threadId: string): Promise<string>;
  /** Write data (keystrokes) to a PTY. */
  terminalWrite(ptyId: string, data: string): Promise<void>;
  /** Resize a PTY to the given dimensions. */
  terminalResize(ptyId: string, cols: number, rows: number): Promise<void>;
  /** Kill a single PTY by ID. */
  terminalKill(ptyId: string): Promise<void>;
  /** Kill all PTYs attached to a thread. */
  terminalKillByThread(threadId: string): Promise<void>;

  // Tool call records
  /** Fetch persisted tool call records for a message. */
  listToolCallRecords(messageId: string): Promise<ToolCallRecord[]>;
  /** Fetch child tool call records for a parent tool call. */
  listToolCallRecordsByParent(parentToolCallId: string): Promise<ToolCallRecord[]>;

  // Snapshots
  /** Get a unified diff for a specific file from a turn snapshot. */
  getSnapshotDiff(snapshotId: string, filePath?: string, maxLines?: number): Promise<string>;
  /** Run garbage collection on expired snapshot refs. */
  cleanupSnapshots(): Promise<{ removed: number }>;
}
