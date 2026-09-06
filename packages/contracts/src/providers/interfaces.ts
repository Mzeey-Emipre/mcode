import type { ProviderRuntimeEvent } from "../events/provider-runtime-event.js";
import type { ApprovalReviewMode, InteractionMode, OrchestrationMode, PermissionMode } from "../models/enums.js";
import type { AttachmentMeta } from "../models/attachment.js";
import type { MessageMention } from "../models/mention.js";
import type { GoalLookupResult, GoalState } from "../models/goal.js";
import type {
  PermissionDecision,
  PermissionRequest,
  PermissionResponseAnswers,
} from "../models/permission.js";
import type { ContextWindowMode, ReasoningLevel } from "../models/settings.js";
import type { ProviderModelInfo } from "./models.js";
import type { ProviderUsageInfo } from "./usage.js";
import type { SessionForker } from "./session-forker.js";
import type { Provider } from "../compat/agent-model.js";

/**
 * Identifier for a supported AI provider.
 * "opencode" remains catalog-only until a server adapter ships.
 */
export type ProviderId = "claude" | "codex" | "gemini" | "copilot" | "cursor" | "opencode";

/** How a provider's `resume` mechanism behaves when used to fork a session. */
export type SessionForkBehavior = "clean" | "unsupported";

/** Optional controls for one-shot utility completions. */
export interface CompletionOptions {
  /** Provider-specific reasoning effort for short utility tasks. */
  reasoningLevel?: ReasoningLevel;
}

/** Explicit provider file-tool start used to capture a mutation baseline without publishing narrative UI. */
export interface ProviderFileMutationStart {
  threadId: string;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** Complete provider-native patch update, bound to Mcode's dispatched turn identity. */
export type ProviderTurnDiffUpdate = {
  turnId: string;
  turnExecutionId: string;
  deliveryAttempt: number;
  revision: number;
} & ({ state: "snapshot"; patch: string; nativeFidelity: "agent" } | { state: "indeterminate-empty" } | { state: "invalidated" } | { state: "rejected" });

/** Optional provider capability that pushes complete native turn-diff updates. */
export interface ITurnDiffSource {
  onTurnDiff(handler: (event: ProviderTurnDiffUpdate) => void): () => void;
}

/**
 * Per-Provider knobs that ride on a {@link TurnRequest}, keyed by {@link ProviderId}.
 * Generic call sites cannot reach into the wrong Provider's knobs because the
 * field type is selected by the request's `P` type parameter.
 */
export interface ProviderOptionsByProvider {
  /** Claude: context-window tier and the Haiku thinking toggle. */
  claude: { contextWindowMode?: ContextWindowMode; thinking?: boolean };
  /** Codex: request the OpenAI fast service tier. */
  codex: { fastMode?: boolean };
  /** Copilot: sub-agent name ("interactive" | "plan" | "autopilot" | custom YAML name). */
  copilot: { agent?: string };
  cursor: Record<string, never>;
  gemini: Record<string, never>;
  opencode: Record<string, never>;
}

/**
 * The per-Turn value object passed to {@link IAgentProvider.sendTurn}.
 * `P` selects the Provider-specific `providerOptions` shape.
 *
 * Top-level fields are generic per-Turn inputs and knobs the user may change
 * between Turns. Provider-specific knobs live only in `providerOptions`.
 */
export interface TurnRequest<P extends ProviderId = ProviderId> {
  /** Mcode-owned canonical identifier for this logical turn. */
  turnId: string;
  /** Mcode-owned identity for this logical turn. */
  turnExecutionId: string;
  /** Monotonic dispatch attempt for canonical provider event identity. */
  deliveryAttempt?: number;
  /** SDK session name, currently `mcode-${threadId}`. */
  sessionId: string;
  /** Workspace that owns the thread and any visible-browser automation scope. */
  workspaceId: string;
  /** Owning thread id. */
  threadId: string;
  /** User input text (already wire-wrapped by the orchestrator when needed). */
  message: string;
  /** Selected composer mentions with JS string-offset ranges in `message`. */
  mentions?: MessageMention[];
  attachments?: AttachmentMeta[];
  /** Working directory: the thread's effective worktree or workspace path. */
  cwd: string;
  model: string;
  /** Fallback model if the primary is unavailable. Undefined disables fallback. */
  fallbackModel?: string;
  permissionMode: PermissionMode;
  /** Resolved once for this dispatch attempt before provider delivery begins. */
  approvalReviewMode: ApprovalReviewMode;
  /** Per-Turn interaction state. Plan suppresses Cursor's native auto-answer. */
  interactionMode: InteractionMode;
  /** Requests provider-native proactive delegation without changing reasoning effort. */
  orchestrationMode?: OrchestrationMode;
  reasoningLevel?: ReasoningLevel;
  /** USD budget cap for this Turn. Undefined or 0 disables. */
  maxBudgetUsd?: number;
  /** Max agent turns for this Turn. Undefined or 0 disables. */
  maxTurns?: number;
  /** Whether this turn's user request explicitly authorizes Mcode thread control. */
  threadControlEligible?: boolean;
  /**
   * SDK session id to resume from. When defined the Provider resumes that
   * session; when undefined it starts fresh. Replaces the previous
   * `setSdkSessionId(...)` + `resume: true` two-step dance.
   */
  resumeFrom?: string;
  /** Provider-specific knobs, walled off by `P`. Required; empty-knob Providers pass `{}`. */
  providerOptions: ProviderOptionsByProvider[P];
}

/** A pluggable agent backend that can run sessions and emit events. */
export interface IAgentProvider {
  readonly id: ProviderId;
  /** Static provider capabilities supplied to clients before dispatch. */
  readonly descriptor: Provider;

  /**
   * Whether this provider supports one-shot text completion (e.g. PR draft generation).
   * Use `isCompletionCapable()` to narrow to `ICompletionCapable` before calling `complete()`.
   */
  readonly supportsCompletion: boolean;

  /**
   * How the provider's `resume` mechanism behaves when used to fork a session.
   * Now metadata only (provenance + UI banner) — it no longer drives handoff
   * dispatch. The handoff pipeline delegates to {@link forker} instead:
   * - "clean": resuming creates a forked session; the original session is unaffected.
   * - "unsupported": resuming is not supported or not yet verified.
   */
  readonly sessionForkOnResume: SessionForkBehavior;

  /**
   * The session-fork strategy for this provider's handoff generation. The
   * handoff pipeline calls `provider.forker.fork(req)` instead of branching on
   * {@link sessionForkOnResume}. Clean-resume providers use CleanForker (path
   * B) and providers that cannot fork a session use DeterministicForker (path
   * D). The forkers reach the providers' concrete side-channel methods
   * directly; those methods are intentionally not on this interface.
   */
  readonly forker: SessionForker;

  /**
   * Maximum input characters the provider accepts per turn, across all roles
   * (system + user content + tool results). `string.length` units, not tokens.
   * Tokens vary per model and are not portable.
   *
   * Used to size handoff documents so they fit inside the child provider's
   * first-turn budget.
   * Codex and Copilot use a conservative placeholder of 16_000 until verified.
   */
  readonly maxInputCharactersPerTurn: number;

  /**
   * Start or continue a Turn. The {@link TurnRequest} carries all per-Turn
   * input, knobs, the resume signal (`resumeFrom`), and Provider-specific
   * options (`providerOptions`). Replaces the former 15-parameter
   * `sendMessage` call.
   */
  sendTurn(req: TurnRequest): Promise<void>;

  /** Abort a running session. Returned promise resolves after provider-owned teardown where supported. */
  stopSession(sessionId: string): void | Promise<void>;

  /** Tear down all sessions and release resources. */
  shutdown(): void;

  /** List models available from this provider. */
  listModels(): Promise<ProviderModelInfo[]>;

  /** Return current usage/quota state for this provider. */
  getUsage?(): Promise<ProviderUsageInfo>;

  /**
   * Resolve a pending permission request.
   * Returns true if the requestId was found and resolved, false otherwise.
   */
  resolvePermission?(
    requestId: string,
    decision: PermissionDecision,
    answers?: PermissionResponseAnswers,
  ): boolean;

  /** Return all pending permission requests for a given thread. */
  listPendingPermissions?(threadId: string): PermissionRequest[];

  /** Subscribe to provider runtime events before ingress projects them for renderer consumers. */
  on(event: "event", handler: (event: ProviderRuntimeEvent) => void): void;
  /** Subscribe to private file-tool starts that must be observed before public attribution is known. */
  on(event: "file_mutation_start", handler: (event: ProviderFileMutationStart) => void): void;
  /** Subscribe to provider-level errors. */
  on(event: "error", handler: (error: Error) => void): void;
  /** Subscribe to permission request events (emitted when canUseTool fires). */
  on(event: "permission_request", handler: (request: PermissionRequest) => void): void;
  /** Subscribe to permission resolved events (emitted on session stop cancellation). */
  on(event: "permission_resolved", handler: (payload: { requestId: string; decision: PermissionDecision }) => void): void;
  /** Subscribe to ExitPlanMode capture events (Claude SDK plan output). */
  on(event: "exit_plan_mode", handler: (payload: { threadId: string; planMarkdown: string }) => void): void;
}

/** Provider-neutral result of inspecting automatic approval review support. */
export interface ApprovalReviewSupport {
  status: "available" | "required" | "unavailable";
  supportedModes: readonly ApprovalReviewMode[];
  /** Stable provider-neutral reason for this result. */
  reason: string;
  /** The initial implementation changes only the turn being dispatched. */
  liveChangeScope: "turn" | "none";
}

/** Optional side-effect-free approval-review support inspection. */
export interface IApprovalReviewCapable extends IAgentProvider {
  getApprovalReviewSupport(input: {
    permissionMode: PermissionMode;
    interactionMode: InteractionMode;
    requestedMode: ApprovalReviewMode;
    model: string;
  }): Promise<ApprovalReviewSupport>;
}

/** Narrows a provider that can inspect approval-review support without dispatching work. */
export function isApprovalReviewCapable(provider: IAgentProvider): provider is IApprovalReviewCapable {
  return typeof (provider as Partial<IApprovalReviewCapable>).getApprovalReviewSupport === "function";
}

/** Narrowed view of a provider that can interrupt one exact child turn. */
export interface IChildTurnCancellable extends IAgentProvider {
  /** Interrupt one native child turn while keeping the provider session alive. */
  interruptChildTurn(sessionId: string, nativeThreadId: string, nativeTurnId: string): Promise<void>;
}

/** Type guard for providers that expose exact child-turn interruption. */
export function isChildTurnCancellable(provider: IAgentProvider): provider is IChildTurnCancellable {
  const candidate = provider as Partial<IChildTurnCancellable>;
  return typeof candidate.interruptChildTurn === "function"
    && candidate.descriptor?.capabilities.some((capability) => (
      capability.name === "child-cancellation" && capability.support === "supported"
    )) === true;
}

/** Narrow a provider that exposes native turn-diff updates. */
export function isTurnDiffSource(provider: IAgentProvider): provider is IAgentProvider & ITurnDiffSource {
  return typeof (provider as Partial<ITurnDiffSource>).onTurnDiff === "function";
}

/**
 * Narrowed view of an agent provider that supports one-shot text completion.
 * Use `isCompletionCapable()` to narrow an `IAgentProvider` to this type.
 */
export interface ICompletionCapable extends IAgentProvider {
  readonly supportsCompletion: true;
  /** Run a one-shot prompt and return the raw text response. */
  complete(prompt: string, model: string, cwd: string, options?: CompletionOptions): Promise<string>;
}

/**
 * Type guard: returns true when the provider implements one-shot text completion.
 * Narrows `IAgentProvider` to `ICompletionCapable` so `complete()` is callable without casting.
 */
export function isCompletionCapable(provider: IAgentProvider): provider is ICompletionCapable {
  return provider.supportsCompletion === true && typeof (provider as ICompletionCapable).complete === "function";
}

/**
 * Narrowed view of an agent provider that supports session goals. Providers
 * may implement this through native thread metadata or a local wrapper, but
 * callers receive the same normalized goal state.
 */
export interface IGoalCapable extends IAgentProvider {
  /** Install a goal condition on a session and return the active goal state. */
  setGoal(sessionId: string, condition: string): GoalState | Promise<GoalState>;
  /** Remove the active goal and report whether anything was cleared. */
  clearGoal(sessionId: string): boolean | Promise<boolean>;
  /** Return the active goal state for a session, or undefined. */
  getGoal(sessionId: string): GoalState | undefined | Promise<GoalState | undefined>;
  /** Return active goal lookup metadata without spawning or resuming provider work. */
  getGoalLookup?(sessionId: string): GoalLookupResult | Promise<GoalLookupResult>;
}

/**
 * Type guard: returns true when the provider implements session goals.
 * Narrows `IAgentProvider` to `IGoalCapable` so the goal methods are callable
 * without casting. Replaces the former runtime cast + triple `typeof` guard.
 */
export function isGoalCapable(provider: IAgentProvider): provider is IGoalCapable {
  const candidate = provider as Partial<IGoalCapable>;
  return (
    typeof candidate.setGoal === "function" &&
    typeof candidate.clearGoal === "function" &&
    typeof candidate.getGoal === "function"
  );
}

/**
 * Narrowed view of an agent provider that can force-discard a pooled session.
 * Providers pool a warm CLI session keyed by `sessionId`; `stopSession` is a
 * graceful cancel that may intentionally keep that session warm. `discardSession`
 * is the harder guarantee: it evicts the pooled session and may return a
 * promise that resolves after provider-owned teardown. Use
 * `isSessionEvictable()` to narrow an `IAgentProvider` before calling it.
 */
export interface ISessionEvictable extends IAgentProvider {
  /**
   * Force-discard the pooled session for `sessionId` so the next `sendTurn`
   * spawns fresh. Unlike {@link IAgentProvider.stopSession}, this does not
   * cancel pending permissions, drop goals, or emit an `ended` event — the turn
   * is expected to continue on a new session (e.g. a transient-failure retry).
   */
  discardSession(sessionId: string): void | Promise<void>;
}

/**
 * Type guard: returns true when the provider can force-discard a pooled session.
 * Narrows `IAgentProvider` to `ISessionEvictable` so `discardSession` is
 * callable without casting.
 */
export function isSessionEvictable(provider: IAgentProvider): provider is ISessionEvictable {
  return typeof (provider as Partial<ISessionEvictable>).discardSession === "function";
}

/** Registry that resolves provider instances by ID. */
export interface IProviderRegistry {
  /** Get a single provider by ID. Throws if not registered. */
  resolve(id: ProviderId): IAgentProvider;

  /** Get all registered providers. */
  resolveAll(): IAgentProvider[];

  /** Shut down all providers. */
  shutdown(): void;
}
