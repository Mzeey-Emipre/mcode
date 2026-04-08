import type { AgentEvent } from "../events/agent-event.js";
import type { AttachmentMeta } from "../models/attachment.js";
import type { ReasoningLevel } from "../models/settings.js";

/** Identifier for a supported AI provider. */
export type ProviderId = "claude" | "codex" | "gemini" | "copilot";

/** A pluggable agent backend that can run sessions and emit events. */
export interface IAgentProvider {
  readonly id: ProviderId;

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

  /**
   * One-shot text completion for non-agentic use cases (e.g. PR draft generation).
   * Returns the raw text response from the underlying CLI.
   * Throws if the provider does not support one-shot completion.
   */
  complete(prompt: string, model: string, cwd: string): Promise<string>;

  /** Abort a running session. */
  stopSession(sessionId: string): void;

  /** Store the SDK-assigned session ID for later resume. */
  setSdkSessionId(sessionId: string, sdkSessionId: string): void;

  /** Tear down all sessions and release resources. */
  shutdown(): void;

  /** Subscribe to agent events. */
  on(event: "event", handler: (event: AgentEvent) => void): void;
  /** Subscribe to provider-level errors. */
  on(event: "error", handler: (error: Error) => void): void;
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
