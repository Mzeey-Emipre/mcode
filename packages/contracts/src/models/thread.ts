import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ThreadStatusSchema, ThreadModeSchema, InteractionModeSchema, PermissionModeSchema } from "./enums.js";
import { ContextWindowModeSchema, ReasoningLevelSchema } from "./settings.js";

/** Whether a worktree thread is on a named branch or still branchless on HEAD. */
export const ThreadCheckoutStateSchema = z.enum(["named", "branchless"]);
/** Thread checkout state discriminator. */
export type ThreadCheckoutState = z.infer<typeof ThreadCheckoutStateSchema>;

/** Thread schema matching the SQLite row shape. */
export const ThreadSchema = lazySchema(() =>
  z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  status: ThreadStatusSchema,
  mode: ThreadModeSchema,
  worktree_path: z.string().nullable(),
  branch: z.string(),
  checkout_state: ThreadCheckoutStateSchema.default("named"),
  base_branch: z.string().nullable().default(null),
  /** Whether the worktree was provisioned by the app (true) or attached externally (false). */
  worktree_managed: z.boolean(),
  issue_number: z.number().nullable(),
  pr_number: z.number().nullable(),
  pr_status: z.string().nullable(),
  /** Whether this thread has at least one turn snapshot with file changes. Used to skip listSnapshots on switch when false. */
  has_file_changes: z.boolean().default(false),
  /** The SDK's internal session ID, used for resumeSession after app restart. */
  sdk_session_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  model: z.string().nullable(),
  /** The AI provider used by this thread (e.g. "claude", "codex"). */
  provider: z.string().default("claude"),
  deleted_at: z.string().nullable(),
  /** Last known input token count from the most recent turn. */
  last_context_tokens: z.number().int().nonnegative().nullable(),
  /** Model's context window size from the most recent turn. */
  context_window: z.number().int().nonnegative().nullable(),
  /** Reasoning effort level last used in this thread. */
  reasoning_level: ReasoningLevelSchema.nullable(),
  /** Interaction mode last used (chat or plan). */
  interaction_mode: InteractionModeSchema.nullable(),
  /** Permission mode last used (full or supervised). */
  permission_mode: PermissionModeSchema.nullable(),
  /** Context window mode last used in this thread ("200k" or "1m"). */
  context_window_mode: ContextWindowModeSchema.nullable(),
  /** Boolean thinking toggle last used in this thread. Honored only by models with a thinking toggle (Haiku 4.5). */
  thinking: z.boolean().nullable(),
  /**
   * Codex: when true, request OpenAI fast service tier for turns; false = standard;
   * null = inherit global `settings.provider.codex.fastMode`.
   */
  codex_fast_mode: z.boolean().nullable(),
  /** Selected Copilot sub-agent name. Null means provider default (interactive). */
  copilot_agent: z.string().nullable(),
  /**
   * Thread-scoped default open-in app id (registry id, e.g. "code"). Tier 1 of
   * the three-tier resolution in ADR-0005. Null means no override, so the app
   * falls back to the global default then auto-resolution.
   */
  default_open_in_app: z.string().nullable(),
  /** ID of the parent thread this was branched from. Null for root threads. */
  parent_thread_id: z.string().nullable(),
  /** ID of the message in the parent thread that marks the fork point. */
  forked_from_message_id: z.string().nullable(),
  /** Most recent compaction summary from the AI provider. Used to seed branched thread replays. */
  last_compact_summary: z.string().nullable(),
  }),
);
/** Thread record from the database. */
export type Thread = z.infer<ReturnType<typeof ThreadSchema>>;

/**
 * Thread plus a small slice of its parent workspace, used by the cross-workspace
 * recent-threads landing list. The join is denormalized at the RPC boundary so
 * the renderer can show project context per row without enriching afterwards.
 */
export const RecentThreadSchema = lazySchema(() =>
  ThreadSchema().extend({
    workspace_name: z.string(),
    workspace_path: z.string(),
  }),
);
export type RecentThread = z.infer<ReturnType<typeof RecentThreadSchema>>;
