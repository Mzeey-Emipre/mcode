export interface Workspace {
  id: string;
  name: string;
  path: string;
  provider_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Thread {
  id: string;
  workspace_id: string;
  title: string;
  status: "active" | "paused" | "interrupted" | "errored" | "archived" | "completed" | "deleted";
  mode: "direct" | "worktree";
  worktree_path: string | null;
  branch: string;
  issue_number: number | null;
  pr_number: number | null;
  pr_status: string | null;
  session_name: string;
  pid: number | null;
  created_at: string;
  updated_at: string;
  model: string | null;
  deleted_at: string | null;
}

export interface ToolCall {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  output: string | null;
  isError: boolean;
  isComplete: boolean;
}

export interface Message {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  tool_calls: unknown | null;
  files_changed: unknown | null;
  cost_usd: number | null;
  tokens_used: number | null;
  timestamp: string;
  sequence: number;
  attachments: StoredAttachment[] | null;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sourcePath: string;
}

export interface StoredAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GitBranch {
  name: string;
  shortSha: string;
  type: "local" | "remote" | "worktree";
  isCurrent: boolean;
}

/** A managed git worktree under ~/.mcode/worktrees/. */
export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
}

/** PR metadata returned by the main process. */
export interface PrInfo {
  number: number;
  url: string;
  state: string;
}

/**
 * Permission mode for Claude agent sessions.
 * - "full": maps to SDK bypassPermissions (no prompts, unrestricted access)
 * - "supervised": maps to SDK default mode (prompts for dangerous operations)
 */
export type PermissionMode = "full" | "supervised";

export const PERMISSION_MODES = {
  FULL: "full" as const,
  SUPERVISED: "supervised" as const,
} satisfies Record<string, PermissionMode>;

/**
 * Interaction mode for agent sessions.
 * - "chat": normal conversation with full tool access
 * - "plan": read-only planning mode (no writes or execution)
 */
export type InteractionMode = "chat" | "plan";

export const INTERACTION_MODES = {
  CHAT: "chat" as const,
  PLAN: "plan" as const,
} satisfies Record<string, InteractionMode>;

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
}
