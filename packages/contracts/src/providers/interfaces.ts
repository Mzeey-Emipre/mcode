import type { AgentEvent } from "../events/agent-event.js";
import type { AttachmentMeta } from "../models/attachment.js";
import type { ReasoningLevel } from "../models/settings.js";
import type { ProviderModelInfo } from "./models.js";
import type { ProviderUsageInfo } from "./usage.js";

/**
 * Identifier for a supported AI provider.
 * "cursor" and "opencode" are registered in the frontend model registry as
 * comingSoon placeholders but do not have active server-side adapters yet.
 */
export type ProviderId = "claude" | "codex" | "gemini" | "copilot" | "cursor" | "opencode";

/** A pluggable agent backend that can run sessions and emit events. */
export interface IAgentProvider {
  readonly id: ProviderId;

  /**
   * Whether this provider supports one-shot text completion (e.g. PR draft generation).
   * Use `isCompletionCapable()` to narrow to `ICompletionCapable` before calling `complete()`.
   */
  readonly supportsCompletion: boolean;

  /** Start or continue a session by sending a message. */
  sendMessage(params: {
    sessionId: string;
    message: string;
    cwd: string;
    model: string;
    /** Fallback model to use if the primary model is unavailable. Undefined disables fallback. */
    fallbackModel?: string;
    resume: boolean;
    permissionMode: string;
    attachments?: AttachmentMeta[];
    reasoningLevel?: ReasoningLevel;
  }): void | Promise<void>;

  /** Abort a running session. */
  stopSession(sessionId: string): void;

  /** Store the SDK-assigned session ID for later resume. */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void;

  /** Tear down all sessions and release resources. */
  shutdown(): void;

  /** List models available from this provider. Not all providers support dynamic discovery. */
  listModels?(): Promise<ProviderModelInfo[]>;

  /** Return current usage/quota state for this provider. */
  getUsage?(): Promise<ProviderUsageInfo>;

  /** Subscribe to agent events. */
  on(event: "event", handler: (event: AgentEvent) => void): void;
  /** Subscribe to provider-level errors. */
  on(event: "error", handler: (error: Error) => void): void;
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

/** Registry that resolves provider instances by ID. */
export interface IProviderRegistry {
  /** Get a single provider by ID. Throws if not registered. */
  resolve(id: ProviderId): IAgentProvider;

  /** Get all registered providers. */
  resolveAll(): IAgentProvider[];

  /** Shut down all providers. */
  shutdown(): void;
}
