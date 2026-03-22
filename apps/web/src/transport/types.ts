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
  deleted_at: string | null;
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
}

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

  // Agent commands
  sendMessage(threadId: string, content: string): Promise<number>;
  stopAgent(threadId: string): Promise<void>;
  getActiveAgentCount(): Promise<number>;

  // Message queries
  getMessages(threadId: string, limit: number): Promise<Message[]>;

  // Config
  discoverConfig(workspacePath: string): Promise<Record<string, unknown>>;

  // Meta
  getVersion(): Promise<string>;
}
