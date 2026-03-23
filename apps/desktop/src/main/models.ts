// String union types matching Rust enums (lowercase serde rename)
export type ThreadStatus =
  | "active"
  | "paused"
  | "interrupted"
  | "errored"
  | "archived"
  | "completed"
  | "deleted";

export type ThreadMode = "direct" | "worktree";

export type MessageRole = "user" | "assistant" | "system";

// Interfaces matching the SQLite schema exactly.
// Field names use snake_case to match DB columns and frontend types.ts expectations.

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly provider_config: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Thread {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly mode: ThreadMode;
  readonly worktree_path: string | null;
  readonly branch: string;
  readonly issue_number: number | null;
  readonly pr_number: number | null;
  readonly pr_status: string | null;
  readonly session_name: string;
  readonly pid: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly model: string | null;
  readonly deleted_at: string | null;
}

export interface Message {
  readonly id: string;
  readonly thread_id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly tool_calls: unknown | null;
  readonly files_changed: unknown | null;
  readonly cost_usd: number | null;
  readonly tokens_used: number | null;
  readonly timestamp: string;
  readonly sequence: number;
  readonly attachments: StoredAttachment[] | null;
}

/** Metadata for an image or file attachment. No binary data, just a pointer. */
export interface AttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sourcePath: string;
}

/** Stored attachment metadata (no sourcePath, since files live at a known location). */
export interface StoredAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
