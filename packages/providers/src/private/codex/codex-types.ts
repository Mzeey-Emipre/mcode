/**
 * JSON-RPC 2.0 protocol types for the `codex app-server` NDJSON interface.
 *
 * Source of truth: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
 * in https://github.com/openai/codex
 */

import type { OrchestrationMode, ReasoningLevel } from "@mcode/contracts";
import type { z } from "zod";
import type { codexNoticeSchemas } from "./codex-notification-validation.js";

// JSON-RPC base shapes

/** A JSON-RPC 2.0 request message sent to the codex app-server. */
export interface JsonRpcRequest<T = unknown> { jsonrpc: "2.0"; id: number; method: string; params: T }
/** A JSON-RPC 2.0 response message received from the codex app-server. */
export interface JsonRpcResponse<T = unknown> { jsonrpc: "2.0"; id: number; result?: T; error?: { code: number; message: string; data?: unknown } }
/** A JSON-RPC 2.0 notification (no `id`) pushed by the codex app-server. */
export interface JsonRpcNotification<T = unknown> { jsonrpc: "2.0"; method: string; params: T }

// Initialize RPC

/** Parameters for the `initialize` RPC method. */
export interface InitializeParams { clientInfo: { name: string; version: string }; capabilities: { experimentalApi: boolean } }
/** Result returned by the `initialize` RPC method. */
export interface InitializeResult { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: Record<string, unknown> }

/** Parameters for resolving effective Codex configuration. */
export interface ConfigReadParams { includeLayers?: boolean; cwd?: string | null }
/** Effective Codex configuration returned by `config/read`. */
export interface ConfigReadResult { config: Record<string, unknown> }

// Thread RPCs
// Source: codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts

/** Sandbox mode for the codex app-server. */
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Approval policy for the codex app-server. `"never"` auto-approves all actions. */
export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

/** Reasoning effort levels for the codex app-server. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Maps mcode reasoning levels to the Codex app-server effort field. */
export function toCodexEffort(
  level?: ReasoningLevel,
  orchestrationMode: OrchestrationMode = "standard",
): ReasoningEffort | undefined {
  if (orchestrationMode === "proactive") return "ultra";
  if (!level) return undefined;
  return level;
}

/** Parameters for the `thread/start` RPC method. */
export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  /** Routes this turn's native approval requests to the selected reviewer. */
  approvalsReviewer?: "user" | "auto_review" | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
}

/** Result returned by the `thread/start` RPC method. */
export interface ThreadStartResult {
  /** Top-level threadId (some versions). */
  threadId?: string;
  /** Nested thread object (codex app-server >= 0.104.0). The session ID is at `thread.id`. */
  thread?: {
    id: string;
    name?: string | null;
    agentNickname?: string | null;
    agentRole?: string | null;
    turns?: Array<{
      items?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    }>;
    [key: string]: unknown;
  };
}

/** Parameters for the `thread/resume` RPC method. */
export interface ThreadResumeParams {
  threadId: string;
  /** Return live thread metadata without hydrating its persisted turns. */
  excludeTurns?: boolean;
  /** Override model for the resumed thread. */
  model?: string | null;
  /** Override sandbox mode for the resumed thread. */
  sandbox?: SandboxMode | null;
  /** Override approval policy for the resumed thread. */
  approvalPolicy?: AskForApproval | null;
  /** Override working directory for the resumed thread. */
  cwd?: string | null;
  developerInstructions?: string | null;
}

/** Result returned by the `thread/resume` RPC method. Same dual shape as ThreadStartResult. */
export interface ThreadResumeResult {
  /** Top-level threadId (some versions). */
  threadId?: string;
  /** Nested thread object (codex app-server >= 0.104.0). The session ID is at `thread.id`. */
  thread?: {
    id: string;
    name?: string | null;
    agentNickname?: string | null;
    agentRole?: string | null;
    [key: string]: unknown;
  };
  /** Effective model selected for the resumed thread. */
  model?: string | null;
  /** Effective reasoning effort selected for the resumed thread. */
  reasoningEffort?: ReasoningEffort | null;
}

/** Parameters for the read-only `thread/read` RPC method. */
export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

/** Result returned by the read-only `thread/read` RPC method. */
export interface ThreadReadResult {
  thread: {
    id: string;
    preview?: string | null;
    name?: string | null;
    agentNickname?: string | null;
    agentRole?: string | null;
    turns?: Array<{
      items?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
    }>;
    [key: string]: unknown;
  };
}

/** Parameters for reading the persisted item projection of a Codex thread. */
export interface ThreadItemsListParams {
  threadId: string;
  /** The maximum number of chronological items to return. */
  limit?: number;
  /** The pagination direction. */
  sortDirection?: "asc" | "desc";
}

/** Result returned by the persisted Codex thread-item projection. */
export interface ThreadItemsListResult {
  data?: Array<{
    turnId?: string;
    item?: {
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    };
  }>;
}

// Turn RPCs
// Source: codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts

/** A structured input part for turn messages (discriminants match codex app-server JSON). */
export type TurnInputPart =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

/** Parameters for the `turn/start` RPC method. */
export interface TurnStartParams {
  threadId: string;
  input: TurnInputPart[];
  /** Override model for this turn. */
  model?: string | null;
  /** Override approval policy for this turn and subsequent turns. */
  approvalPolicy?: AskForApproval | null;
  /** Routes this turn's native approval requests to the selected reviewer. */
  approvalsReviewer?: "user" | "auto_review" | null;
  /** Override reasoning effort for this turn and subsequent turns. */
  effort?: ReasoningEffort | null;
  /**
   * OpenAI API service tier for this turn (e.g. `"priority"`). Omitted for default processing.
   * Field name matches codex-rs app-server generated TypeScript (camelCase).
   */
  serviceTier?: string | null;
}

/** Per-turn overrides passed from {@link CodexProvider} to {@link CodexAppServer.sendTurn}. */
export type CodexTurnOptions = Pick<TurnStartParams, "model" | "effort" | "serviceTier" | "approvalsReviewer">;

/** Result returned by the `turn/start` RPC method. */
export interface TurnStartResult {
  /** Top-level turn id (some versions). */
  turnId?: string;
  /** Nested turn object (canonical per OpenAI app-server docs). */
  turn?: { id: string; [key: string]: unknown };
}
/** Parameters for the `turn/interrupt` RPC method. */
export interface TurnInterruptParams { threadId: string; turnId: string }
/** Result returned by the `turn/interrupt` RPC method. */
export type TurnInterruptResult = Record<string, never>;

/** Native lifecycle state for a Codex thread goal. */
export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

/** Native goal object returned by Codex app-server thread goal RPCs. */
export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** Parameters for the `thread/goal/set` RPC method. */
export interface ThreadGoalSetParams {
  threadId: string;
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
}

/** Result returned by the `thread/goal/set` RPC method. */
export interface ThreadGoalSetResult { goal: ThreadGoal }

/** Parameters for the `thread/goal/get` RPC method. */
export interface ThreadGoalGetParams { threadId: string }

/** Result returned by the `thread/goal/get` RPC method. */
export interface ThreadGoalGetResult { goal: ThreadGoal | null }

/** Parameters for the `thread/goal/clear` RPC method. */
export interface ThreadGoalClearParams { threadId: string }

/** Result returned by the `thread/goal/clear` RPC method. */
export interface ThreadGoalClearResult { cleared: boolean }

// Handshake RPCs

/** Result returned by the `model/list` RPC method. */
export interface ModelListResult { models: Array<{ id: string; name?: string }> }
/** Result returned by the `account/read` RPC method. */
export interface AccountReadResult { id?: string; email?: string; name?: string }
/** Result returned by the `account/rateLimits/read` RPC method. */
export interface AccountRateLimitsReadResult extends CodexRateLimitsPayload {
  rateLimitResetCredits?: { availableCount?: number } | null;
}

// Skill RPCs

/** Parameters for the `skills/list` RPC method. */
export interface SkillsListParams {
  cwds?: string[];
  forceReload?: boolean;
}

/** Skill metadata returned by the `skills/list` RPC method. */
export interface CodexSkillMetadata {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  scope: "user" | "repo" | "system" | "admin" | string;
  shortDescription?: string | null;
  interface?: {
    shortDescription?: string | null;
    displayName?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** Result returned by the `skills/list` RPC method. */
export interface SkillsListResult {
  data: Array<{
    cwd: string;
    errors: Array<{ message: string; path: string }>;
    skills: CodexSkillMetadata[];
  }>;
}

// Plugin RPCs

/** Parameters for the `plugin/list` RPC method. */
export interface PluginListParams {
  cwds?: string[];
}

/** Composer metadata included in a Codex plugin summary. */
export interface CodexPluginInterface {
  displayName?: string | null;
  shortDescription?: string | null;
  longDescription?: string | null;
  developerName?: string | null;
  capabilities?: string[];
  [key: string]: unknown;
}

/** Installed-state metadata returned for a Codex plugin. */
export interface CodexPluginSummary {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  version?: string | null;
  localVersion?: string | null;
  interface?: CodexPluginInterface | null;
  [key: string]: unknown;
}

/** One plugin marketplace and its summarized plugins. */
export interface CodexPluginMarketplace {
  name: string;
  path: string | null;
  plugins: CodexPluginSummary[];
  [key: string]: unknown;
}

/** Result returned by the `plugin/list` RPC method. */
export interface PluginListResult {
  marketplaces: CodexPluginMarketplace[];
  marketplaceLoadErrors: Array<{ marketplacePath: string; message: string }>;
  featuredPluginIds: string[];
}

/** Parameters for the `plugin/read` RPC method. */
export interface PluginReadParams {
  marketplacePath?: string;
  remoteMarketplaceName?: string;
  pluginName: string;
}

/** Result returned by the `plugin/read` RPC method. */
export interface PluginReadResult {
  plugin: {
    description?: string | null;
    summary?: CodexPluginSummary;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Notification payloads
// Source: codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts
// ---------------------------------------------------------------------------

// Silently-consumed lifecycle payloads (no data needed)
/** Payload for notifications silently consumed as lifecycle events. */
export interface LifecyclePayload { [key: string]: unknown }

// Streaming delta payloads

/** Payload for `item/agentMessage/delta` - streaming assistant text token. */
export interface AgentMessageDeltaPayload { threadId?: string; turnId?: string; itemId?: string; delta: string }
/** Payload for `item/commandExecution/outputDelta` - streaming shell output token. */
export interface CommandExecOutputDeltaPayload { threadId?: string; turnId?: string; itemId?: string; delta: string }
/** Payload for `item/reasoning/textDelta` and `item/reasoning/summaryTextDelta` streaming tokens. */
export interface ReasoningStreamDeltaPayload {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  text?: string;
  [key: string]: unknown;
}

/** Payload for experimental `item/plan/delta` streaming tokens (Codex app-server). */
export interface PlanDeltaPayload {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta: string;
}

/** Payload for `turn/plan/updated`, Codex's structured per-turn plan snapshot. */
export interface TurnPlanUpdatedPayload {
  threadId?: string;
  turnId?: string;
  explanation?: string;
  plan?: unknown[];
  [key: string]: unknown;
}

// item/completed payload

/**
 * A completed `ThreadItem` from the agent. Discriminated on `type`.
 *
 * Known types (from codex-rs/app-server-protocol):
 *   userMessage, agentMessage, commandExecution, fileChange, mcpToolCall,
 *   dynamicToolCall, collabAgentToolCall, subAgentActivity, reasoning, webSearch, plan,
 *   imageView, imageGeneration, contextCompaction, enteredReviewMode, exitedReviewMode
 */
export interface CompletedItem {
  type: string;
  id?: string;

  // agentMessage
  role?: string;
  content?: Array<{ type: string; text?: string }>;

  // commandExecution (v2 uses aggregatedOutput; older payloads may use output)
  command?: string;
  output?: string | null;
  aggregatedOutput?: string | null;
  exitCode?: number | null;

  // fileChange
  changes?: Array<{ path: string; kind: string }>;

  // mcpToolCall / dynamicToolCall / collabAgentToolCall (`tool` is CollabAgentTool in app-server v2)
  server?: string;
  tool?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  result?: string | null;
  error?: string | null;

  // subAgentActivity
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;

  /** `item/completed` with `type: "reasoning"` — human-readable summary lines */
  summary?: string[];
  /** `item/completed` with `type: "reasoning"` — raw reasoning text segments */
  reasoningContent?: string[];

  // function_call (OpenAI Responses API shape, may appear in some versions)
  // imageGeneration
  savedPath?: string;
  revisedPrompt?: string | null;

  [key: string]: unknown;
}

/** Payload for the `item/started` notification. */
export interface ItemStartedPayload { threadId?: string; turnId?: string; item?: CompletedItem }
/** Payload for the `item/completed` notification. */
export interface ItemCompletedPayload { threadId?: string; turnId?: string; item?: CompletedItem }

/** Authoritative effective model settings for a Codex thread. */
export interface ThreadSettingsUpdatedPayload {
  threadId: string;
  threadSettings: {
    model?: string | null;
    effort?: ReasoningEffort | null;
    [key: string]: unknown;
  };
}

// turn/completed payload

/** Error detail from a failed turn or error notification. */
export interface TurnErrorInfo { message?: string; codexErrorInfo?: string; additionalDetails?: unknown }

/** The `turn` object nested inside a `turn/completed` payload. */
export interface TurnResult {
  id?: string;
  items?: unknown[];
  /** `"completed"` on success, `"failed"` or `"interrupted"` otherwise. */
  status?: "completed" | "failed" | "interrupted" | "inProgress" | string;
  error?: TurnErrorInfo;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** Payload for the `turn/completed` notification. */
export interface TurnCompletedPayload { threadId?: string; turn?: TurnResult; [key: string]: unknown }

/**
 * Payload for the `error` notification.
 * Fired for transient mid-turn errors; `willRetry` indicates the agent will retry.
 * Terminal failures arrive via `turn/completed` with `turn.status === "failed"`.
 */
export interface ErrorNotificationPayload {
  threadId?: string;
  turnId?: string;
  error?: TurnErrorInfo;
  willRetry?: boolean;
  [key: string]: unknown;
}

/** Native notice payloads share their runtime validation schemas. */
export type WarningNotificationPayload = z.infer<typeof codexNoticeSchemas.warning>;
export type GuardianWarningNotificationPayload = z.infer<typeof codexNoticeSchemas.guardianWarning>;
export type WorldWritableWarningNotificationPayload = z.infer<typeof codexNoticeSchemas["windows/worldWritableWarning"]>;
export type ModelReroutedNotificationPayload = z.infer<typeof codexNoticeSchemas["model/rerouted"]>;
export type ConfigWarningNotificationPayload = z.infer<typeof codexNoticeSchemas.configWarning>;
export type DeprecationNoticeNotificationPayload = z.infer<typeof codexNoticeSchemas.deprecationNotice>;
export type AuthRecoveryCompletedNotificationPayload = z.infer<typeof codexNoticeSchemas["modelProvider/authRecoveryCompleted"]>;

/** One Codex account rate-limit window from `account/rateLimits/updated`. */
export interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

/** Account rate-limit payload from the Codex app-server. */
export interface CodexRateLimitsPayload {
  rateLimits?: {
    primary?: CodexRateLimitWindow | null;
    secondary?: CodexRateLimitWindow | null;
    planType?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/** Payload for native Codex goal-update notifications. */
export interface ThreadGoalUpdatedPayload {
  threadId: string;
  turnId?: string | null;
  goal: ThreadGoal;
}

/** Payload for native Codex goal-cleared notifications. */
export interface ThreadGoalClearedPayload {
  threadId: string;
  turnId?: string | null;
}

/** Native status values for a Codex app-server MCP startup attempt. */
export type McpServerStartupStatus = "starting" | "ready" | "failed" | "cancelled";

/** Payload for `mcpServer/startupStatus/updated` notifications. */
export interface McpServerStartupStatusUpdatedPayload {
  threadId?: string;
  name: string;
  status: McpServerStartupStatus;
  error?: string | null;
  failureReason?: string | null;
}

/** Schema-derived known notifications and explicitly classified unknown native envelopes. */
export type { ValidatedCodexNotification as CodexNotification } from "./codex-notification-validation.js";
