import type { AgentEvent } from "../events/agent-event.js";
import type { InteractionMode } from "../models/enums.js";
import type { AttachmentMeta } from "../models/attachment.js";
import type { PermissionDecision, PermissionRequest } from "../models/permission.js";
import type { ContextWindowMode, ReasoningLevel } from "../models/settings.js";
import type { ProviderModelInfo } from "./models.js";
import type { ProviderUsageInfo } from "./usage.js";
import type { SessionForker } from "./session-forker.js";

/**
 * Identifier for a supported AI provider.
 * "opencode" remains catalog-only until a server adapter ships.
 */
export type ProviderId = "claude" | "codex" | "gemini" | "copilot" | "cursor" | "opencode";

/** How a provider's `resume` mechanism behaves when used to fork a session. */
export type SessionForkBehavior = "clean" | "unsupported";

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
  /** SDK session name, currently `mcode-${threadId}`. */
  sessionId: string;
  /** Owning thread id. */
  threadId: string;
  /** User input text (already wire-wrapped by the orchestrator when needed). */
  message: string;
  attachments?: AttachmentMeta[];
  /** Working directory: the thread's effective worktree or workspace path. */
  cwd: string;
  model: string;
  /** Fallback model if the primary is unavailable. Undefined disables fallback. */
  fallbackModel?: string;
  permissionMode: string;
  /** Per-Turn interaction state. Plan suppresses Cursor's native auto-answer. */
  interactionMode: InteractionMode;
  reasoningLevel?: ReasoningLevel;
  /** USD budget cap for this Turn. Undefined or 0 disables. */
  maxBudgetUsd?: number;
  /** Max agent turns for this Turn. Undefined or 0 disables. */
  maxTurns?: number;
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

  /** Abort a running session. */
  stopSession(sessionId: string): void;

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
  resolvePermission?(requestId: string, decision: PermissionDecision): boolean;

  /** Return all pending permission requests for a given thread. */
  listPendingPermissions?(threadId: string): PermissionRequest[];

  /** Subscribe to agent events. */
  on(event: "event", handler: (event: AgentEvent) => void): void;
  /** Subscribe to provider-level errors. */
  on(event: "error", handler: (error: Error) => void): void;
  /** Subscribe to permission request events (emitted when canUseTool fires). */
  on(event: "permission_request", handler: (request: PermissionRequest) => void): void;
  /** Subscribe to permission resolved events (emitted on session stop cancellation). */
  on(event: "permission_resolved", handler: (payload: { requestId: string; decision: PermissionDecision }) => void): void;
  /** Subscribe to ExitPlanMode capture events (Claude SDK plan output). */
  on(event: "exit_plan_mode", handler: (payload: { threadId: string; planMarkdown: string }) => void): void;
}

/**
 * Narrowed view of an agent provider that supports one-shot text completion.
 * Use `isCompletionCapable()` to narrow an `IAgentProvider` to this type.
 */
export interface ICompletionCapable extends IAgentProvider {
  readonly supportsCompletion: true;
  /** Run a one-shot prompt and return the raw text response. */
  complete(prompt: string, model: string, cwd: string): Promise<string>;
}

/**
 * Type guard: returns true when the provider implements one-shot text completion.
 * Narrows `IAgentProvider` to `ICompletionCapable` so `complete()` is callable without casting.
 */
export function isCompletionCapable(provider: IAgentProvider): provider is ICompletionCapable {
  return provider.supportsCompletion === true && typeof (provider as ICompletionCapable).complete === "function";
}

/**
 * Narrowed view of an agent provider that supports session goals. A goal
 * installs a Stop-hook gate that blocks the provider from ending its turn
 * until the goal is cleared. Use `isGoalCapable()` to narrow an
 * `IAgentProvider` to this type before calling the goal methods.
 */
export interface IGoalCapable extends IAgentProvider {
  /** Install a goal condition on a session. */
  setGoal(sessionId: string, condition: string): void;
  /** Remove the active goal so the next Stop event is allowed through. */
  clearGoal(sessionId: string): void;
  /** Return the active goal condition for a session, or undefined. */
  getGoal(sessionId: string): string | undefined;
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
 * is the harder guarantee: it evicts the pooled session so the next `sendTurn`
 * spawns a genuinely fresh subprocess. Use `isSessionEvictable()` to narrow an
 * `IAgentProvider` before calling it.
 */
export interface ISessionEvictable extends IAgentProvider {
  /**
   * Force-discard the pooled session for `sessionId` so the next `sendTurn`
   * spawns fresh. Unlike {@link IAgentProvider.stopSession}, this does not
   * cancel pending permissions, drop goals, or emit an `ended` event — the turn
   * is expected to continue on a new session (e.g. a transient-failure retry).
   */
  discardSession(sessionId: string): void;
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
