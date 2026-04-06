import { z } from "zod";
import { ThreadStatusSchema, ThreadModeSchema } from "./enums.js";

/** Thread schema matching the SQLite row shape. */
export const ThreadSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  status: ThreadStatusSchema,
  mode: ThreadModeSchema,
  worktree_path: z.string().nullable(),
  branch: z.string(),
  /** Whether the worktree was provisioned by the app (true) or attached externally (false). */
  worktree_managed: z.boolean(),
  issue_number: z.number().nullable(),
  pr_number: z.number().nullable(),
  pr_status: z.string().nullable(),
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
  reasoning_level: z.string().nullable(),
  /** Interaction mode last used (chat or plan). */
  interaction_mode: z.string().nullable(),
  /** Permission mode last used (full or supervised). */
  permission_mode: z.string().nullable(),
});
/** Thread record from the database. */
export type Thread = z.infer<typeof ThreadSchema>;
