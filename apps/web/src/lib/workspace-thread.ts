import type { Thread } from "@/transport";
import type { ContextWindowMode, OrchestrationMode, ReasoningLevel } from "@mcode/contracts";

/**
 * Thread row in the workspace store may include client-only fields while the
 * server-backed record is still being created.
 */
export type WorkspaceThread = Thread & {
  /** True while createAndSend / branch RPC is in flight. */
  clientPreparing?: boolean;
  /** Set when creation failed; user can retry or dismiss. */
  clientError?: string | null;
  /** Non-fatal warnings from thread creation (e.g. worktree checkout issues). */
  clientWarnings?: string[] | null;
  /** Message body shown in the preparing shell (mirrors cleared composer input). */
  clientQueuedMessage?: string;
  /** Client-generated startup lifecycle identity retained after the Thread is created. */
  clientStartupId?: string;
  /**
   * Drives status copy in the preparing shell (new vs branch, direct vs worktree).
   */
  clientPreparingContext?:
    | "new-direct"
    | "new-worktree"
    | "new-existing-worktree"
    | "branch-direct"
    | "branch-worktree"
    | "branch-existing-worktree";
};

const TITLE_MAX = 72;

/**
 * Derives a thread title from the first line or first chars of the user's message.
 */
export function titleFromMessageContent(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? content;
  const trimmed = firstLine.trim();
  if (trimmed.length <= TITLE_MAX) return trimmed || "New thread";
  return `${trimmed.slice(0, TITLE_MAX - 1)}…`;
}

/** Union of all preparing-context values for exhaustive switch checks. */
export type ClientPreparingContext = NonNullable<WorkspaceThread["clientPreparingContext"]>;

type PlaceholderWorkspaceThreadParams = {
  id: string;
  workspaceId: string;
  title: string;
  queuedMessage: string;
  transportMode: "direct" | "worktree";
  branch: string;
  checkoutState?: Thread["checkout_state"];
  baseBranch?: string | null;
  worktreePath?: string | null;
  worktreeManaged?: boolean;
  clientPreparingContext: ClientPreparingContext;
  startupId?: string;
  model?: string | null;
  provider?: string | null;
  reasoningLevel?: ReasoningLevel | null;
  interactionMode?: Thread["interaction_mode"];
  orchestrationMode?: OrchestrationMode | null;
  permissionMode?: Thread["permission_mode"];
  contextWindow?: ContextWindowMode | null;
  thinking?: boolean | null;
  codexFastMode?: boolean | null;
  copilotAgent?: string | null;
  parentThreadId?: string | null;
  forkedFromMessageId?: string | null;
};

function resolveCheckoutFields(params: PlaceholderWorkspaceThreadParams) {
  const checkoutState =
    params.checkoutState ?? (params.transportMode === "worktree" ? "branchless" : "named");

  return {
    worktree_path: params.worktreePath ?? null,
    checkout_state: checkoutState,
    base_branch: params.baseBranch ?? (checkoutState === "branchless" ? params.branch : null),
    worktree_managed: params.worktreeManaged ?? params.transportMode === "worktree",
  };
}

function resolveProviderFields(params: PlaceholderWorkspaceThreadParams) {
  return {
    model: params.model ?? null,
    provider: params.provider ?? "claude",
    reasoning_level: params.reasoningLevel ?? null,
    interaction_mode: params.interactionMode ?? null,
    orchestration_mode: params.orchestrationMode ?? null,
    ...resolveProviderOptionFields(params),
  };
}

function resolveProviderOptionFields(params: PlaceholderWorkspaceThreadParams) {
  return {
    permission_mode: params.permissionMode ?? null,
    context_window_mode: params.contextWindow ?? null,
    thinking: params.thinking ?? null,
    codex_fast_mode: params.codexFastMode ?? null,
    copilot_agent: params.copilotAgent ?? null,
    parent_thread_id: params.parentThreadId ?? null,
    forked_from_message_id: params.forkedFromMessageId ?? null,
  };
}

/**
 * User-visible status line for the preparing shell.
 */
export function preparingStatusLabel(ctx: ClientPreparingContext): string {
  switch (ctx) {
    case "new-direct":
    case "branch-direct":
      return "Starting thread…";
    case "new-worktree":
    case "branch-worktree":
      return "Creating worktree…";
    case "new-existing-worktree":
    case "branch-existing-worktree":
      return "Attaching worktree…";
    default: {
      const _exhaustive: never = ctx;
      return _exhaustive;
    }
  }
}

/**
 * Builds a minimal {@link Thread} shape for an optimistic sidebar row and chat shell.
 */
export function buildPlaceholderWorkspaceThread(
  params: PlaceholderWorkspaceThreadParams,
): WorkspaceThread {
  const now = new Date().toISOString();
  return {
    id: params.id,
    workspace_id: params.workspaceId,
    title: params.title,
    status: "active",
    mode: params.transportMode,
    branch: params.branch,
    ...resolveCheckoutFields(params),
    issue_number: null,
    pr_number: null,
    pr_status: null,
    has_file_changes: false,
    sdk_session_id: null,
    created_at: now,
    updated_at: now,
    ...resolveProviderFields(params),
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    last_compact_summary: null,
    default_open_in_app: null,
    clientPreparing: true,
    clientError: null,
    clientQueuedMessage: params.queuedMessage,
    clientStartupId: params.startupId,
    clientPreparingContext: params.clientPreparingContext,
  };
}
