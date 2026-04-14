import { z } from "zod";

/** Thread lifecycle status. */
export const ThreadStatusSchema = z.enum([
  "active",
  "paused",
  "interrupted",
  "errored",
  "archived",
  "completed",
  "deleted",
]);
/** Thread lifecycle status value. */
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

/** Thread isolation mode. */
export const ThreadModeSchema = z.enum(["direct", "worktree"]);
/** Thread isolation mode value. */
export type ThreadMode = z.infer<typeof ThreadModeSchema>;

/** Message author role. */
export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
/** Message author role value. */
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * Permission mode for agent sessions.
 * - "full": bypass all permission prompts (unrestricted access)
 * - "supervised": prompt for dangerous operations
 */
export const PermissionModeSchema = z.enum(["full", "supervised"]);
/** Permission mode for agent sessions. */
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** Constant lookup for permission modes. */
export const PERMISSION_MODES = {
  FULL: "full" as const,
  SUPERVISED: "supervised" as const,
} satisfies Record<string, PermissionMode>;

/**
 * Interaction mode for agent sessions.
 * - "chat": normal conversation with full tool access
 * - "plan": read-only planning mode (no writes or execution)
 */
export const InteractionModeSchema = z.enum(["chat", "plan"]);
/** Interaction mode for agent sessions. */
export type InteractionMode = z.infer<typeof InteractionModeSchema>;

/** Constant lookup for interaction modes. */
export const INTERACTION_MODES = {
  CHAT: "chat" as const,
  PLAN: "plan" as const,
} satisfies Record<string, InteractionMode>;

/** Discriminates where a Copilot sub-agent was discovered from. */
export const CopilotSubagentSourceSchema = z.enum(["default", "user", "project"]);
/** Copilot sub-agent source value. */
export type CopilotSubagentSource = z.infer<typeof CopilotSubagentSourceSchema>;
/** Constant lookup for Copilot sub-agent sources. */
export const COPILOT_SUBAGENT_SOURCES = {
  DEFAULT: "default" as const,
  USER: "user" as const,
  PROJECT: "project" as const,
} satisfies Record<string, CopilotSubagentSource>;
