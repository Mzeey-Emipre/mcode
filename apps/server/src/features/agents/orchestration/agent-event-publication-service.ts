import { AgentEventType, type AgentEvent, type IProviderRegistry, type PermissionRequest } from "@mcode/contracts";
import type { TurnPullRequestCompletionEffect } from "../../pull-requests/index.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { publishParentProviderEvent } from "../events/provider-event-publication.js";
import { publishAgentPermissionEvents } from "../permissions/permission-publication.js";
import { sanitizePublicToolInput } from "../tools/input/public-tool-input.js";
import { normalizeAgentProviderError } from "./provider-agent-error-normalize.js";

/** The runtime read surface needed to prepare renderer-facing provider events. */
export interface AgentEventPublicationRuntime {
  getCurrentFileEffectTurnId(threadId: string): string | undefined;
  shouldSuppressTurnEnded(threadId: string): boolean;
  shouldSuppressTurnComplete(threadId: string): boolean;
  shouldSuppressTransientTurnError(threadId: string, errorMessage: string): boolean;
}

/** Dependencies required to publish already-normalized provider events. */
export interface AgentEventPublicationDependencies {
  runtime: AgentEventPublicationRuntime;
  threads: ThreadRepo;
  narrative: NarrativeStore;
  pullRequests: TurnPullRequestCompletionEffect;
  providers: IProviderRegistry;
  publishAgentEvent(event: AgentEvent): void;
  publishPermissionRequest(request: PermissionRequest): void;
  publishPermissionResolved(payload: { requestId: string; decision: "allow" | "allow-session" | "deny" | "cancelled" }): void;
  publishThreadStatus(payload: { threadId: string; status: "completed" | "errored" | "interrupted" }): void;
}

/** Owns renderer publication and post-terminal best-effort completion effects. */
export class AgentEventPublicationService {
  constructor(private readonly dependencies: AgentEventPublicationDependencies) {}

  /** Register the provider-neutral permission publication bridge. */
  start(): void {
    publishAgentPermissionEvents({
      providerRegistry: this.dependencies.providers,
      publishPermissionRequest: this.dependencies.publishPermissionRequest,
      publishPermissionResolved: this.dependencies.publishPermissionResolved,
    });
  }

  /** Publish one provider event after its synchronous persistence application completed. */
  publish(event: AgentEvent): void {
    if (this.shouldSuppress(event)) return;
    const enriched = this.sanitize(this.enrich(event));
    const published = publishParentProviderEvent(event, enriched, {
      publishAgentEvent: this.dependencies.publishAgentEvent,
      updateThreadStatus: (threadId, status) => this.dependencies.threads.updateStatus(threadId, status),
      publishThreadStatus: this.dependencies.publishThreadStatus,
    });
    if (published && event.type === AgentEventType.TurnComplete) this.dependencies.pullRequests.schedule(event.threadId);
  }

  private shouldSuppress(event: AgentEvent): boolean {
    if (event.type === AgentEventType.Ended) return this.dependencies.runtime.shouldSuppressTurnEnded(event.threadId);
    if (event.type === AgentEventType.TurnComplete) return this.dependencies.runtime.shouldSuppressTurnComplete(event.threadId);
    return event.type === AgentEventType.Error
      && this.dependencies.runtime.shouldSuppressTransientTurnError(event.threadId, event.error ?? "");
  }

  private enrich(event: AgentEvent): AgentEvent {
    const withFileEffect = this.enrichTurnStart(event);
    const withParent = this.enrichToolParent(withFileEffect);
    return this.enrichError(withParent);
  }

  private enrichTurnStart(event: AgentEvent): AgentEvent {
    if (event.type !== AgentEventType.TurnStarted) return event;
    const fileEffectTurnId = this.dependencies.runtime.getCurrentFileEffectTurnId(event.threadId);
    return fileEffectTurnId ? { ...event, fileEffectTurnId } : event;
  }

  private enrichToolParent(event: AgentEvent): AgentEvent {
    if (event.type !== AgentEventType.ToolUse || event.toolName === "Agent" || event.parentToolCallId) return event;
    const parentToolCallId = this.dependencies.narrative.getCurrentParentToolCallId(event.threadId);
    return parentToolCallId ? { ...event, parentToolCallId } : event;
  }

  private enrichError(event: AgentEvent): AgentEvent {
    if (event.type !== AgentEventType.Error) return event;
    const provider = this.dependencies.threads.findById(event.threadId)?.provider || "claude";
    return { ...event, error: normalizeAgentProviderError(provider, event.error ?? "") };
  }

  private sanitize(event: AgentEvent): AgentEvent {
    if (event.type === AgentEventType.ToolUse) {
      return { ...event, toolInput: sanitizePublicToolInput(event.toolInput, event.toolName) };
    }
    if (event.type === AgentEventType.ToolResult && event.toolInput) {
      return { ...event, toolInput: sanitizePublicToolInput(event.toolInput) };
    }
    return event;
  }
}
