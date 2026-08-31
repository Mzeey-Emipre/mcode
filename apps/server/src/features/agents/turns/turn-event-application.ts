import { AgentEventType } from "@mcode/contracts";
import type { AgentEvent, ProviderId } from "@mcode/contracts";

import type {
  CanonicalProviderEventReceipt,
  ProviderEventIngressEvent,
  ProviderEventSourceKind,
} from "../../providers/composition/provider-event-ingress.js";

/** Bounded provenance used to decide whether the application must add a diagnostic record. */
export interface TurnEventDiagnosticProvenance {
  sourceKind: ProviderEventSourceKind;
  canonicalReceipt?: Pick<CanonicalProviderEventReceipt, "eventId" | "durableRevision">;
}

/** Performs one provider-neutral normalized event effect without owning ingress ordering. */
export interface TurnEventEffects {
  /** Record a bounded ingress diagnostic decision before renderer publication. */
  recordDiagnostic(provenance: TurnEventDiagnosticProvenance, event: AgentEvent): void;
  /** Persist or buffer one text delta. */
  applyTextDelta(event: Extract<AgentEvent, { type: "textDelta" }>): boolean | undefined;
  /** Buffer a provider attachment. */
  applyGeneratedAttachment(event: Extract<AgentEvent, { type: "generatedAttachment" }>): boolean | undefined;
  /** Buffer or materialize an assistant message. */
  applyMessage(providerId: ProviderId, event: Extract<AgentEvent, { type: "message" }>): boolean | undefined;
  /** Classify streamed assistant text at its authoritative boundary. */
  applyAssistantMessageBoundary(event: Extract<AgentEvent, { type: "assistantMessageBoundary" }>): boolean | undefined;
  /** Apply a tool start to narrative and durable file effects. */
  applyToolUse(event: Extract<AgentEvent, { type: "toolUse" }>): boolean | undefined;
  /** Apply a hook start to narrative. */
  applyHookStarted(event: Extract<AgentEvent, { type: "hookStarted" }>): boolean | undefined;
  /** Apply a hook completion and report whether it owns publication. */
  applyHookCompleted(event: Extract<AgentEvent, { type: "hookCompleted" }>): boolean | undefined;
  /** Apply a tool completion to narrative and durable file effects. */
  applyToolResult(event: Extract<AgentEvent, { type: "toolResult" }>): boolean | undefined;
  /** Admit a newly started turn. */
  applyTurnStarted(event: Extract<AgentEvent, { type: "turnStarted" }>): boolean | undefined;
  /** Apply a completed turn and request its terminal materialization. */
  applyTurnComplete(event: Extract<AgentEvent, { type: "turnComplete" }>): boolean | undefined;
  /** Apply a provider error and request its terminal materialization. */
  applyError(event: Extract<AgentEvent, { type: "error" }>): boolean | undefined;
  /** Track a compaction lifecycle transition. */
  applyCompacting(event: Extract<AgentEvent, { type: "compacting" }>): boolean | undefined;
  /** Persist a compacted context summary. */
  applyCompactSummary(event: Extract<AgentEvent, { type: "compactSummary" }>): boolean | undefined;
  /** Persist provider system state such as a resumable session cursor. */
  applySystem(providerId: ProviderId, event: Extract<AgentEvent, { type: "system" }>): boolean | undefined;
  /** Apply a terminal stream end and request its materialization. */
  applyEnded(event: Extract<AgentEvent, { type: "ended" }>): boolean | undefined;
  /** Complete the parent-text durability checkpoint before terminal publication. */
  finishAssistantText(executionId: string): boolean;
  /** Return whether the textual sidecar is currently unsaved. */
  isAssistantTextUnsaved(executionId: string): boolean;
  /** Stop the provider when parent text cannot remain durable. */
  interruptForAssistantTextFailure(event: AgentEvent, reason: string): void;
  /** Checkpoint renderer-facing narrative state. */
  checkpointNarrative(event: AgentEvent): void;
  /** Stop the provider when its narrative checkpoint failed. */
  interruptForNarrativeFailure(event: AgentEvent, error: unknown): void;
  /** Return whether a hook belongs to a completed turn. */
  isLateHook(event: AgentEvent): boolean;
  /** Return whether a hook completion will publish itself after durable persistence. */
  ownsLateHookPublication(event: AgentEvent): boolean;
  /** Publish one event after all durable prerequisites have completed. */
  publish(event: AgentEvent): void;
  /** Return the terminal file-effect finalization, if one is in flight. */
  fileFinalization(threadId: string): Promise<boolean> | undefined;
}

/** Applies normalized events, checkpoints renderer state, and delays terminal publication for durability. */
export class TurnEventApplication {
  constructor(private readonly effects: TurnEventEffects) {}

  /** Apply one event from the provider-neutral queue while preserving ingress provenance. */
  apply(input: ProviderEventIngressEvent, event: AgentEvent, publish: boolean): boolean {
    const terminal = isTerminal(event);
    if (!this.prepareTerminalText(event, publish, terminal)) return false;
    const accepted = this.applyEffect(input, event);
    if (accepted === false) return true;
    if (terminal && accepted !== true) return false;
    if (!this.checkpoint(event, publish)) return false;
    if (publish && this.effects.ownsLateHookPublication(event)) return true;
    if (publish) this.publishAfterDurability(event, terminal);
    return true;
  }

  private prepareTerminalText(event: AgentEvent, publish: boolean, terminal: boolean): boolean {
    if (!publish || !terminal || !event.turnExecutionId) return true;
    if (this.effects.finishAssistantText(event.turnExecutionId)) return true;
    if (!this.effects.isAssistantTextUnsaved(event.turnExecutionId)) {
      this.effects.interruptForAssistantTextFailure(
        event,
        "Assistant text recovery remained unavailable at turn finalization",
      );
    }
    return false;
  }

  private checkpoint(event: AgentEvent, publish: boolean): boolean {
    if (!publish || isUnsavedNarrationBoundary(event, this.effects)) return true;
    try {
      this.effects.checkpointNarrative(event);
      return true;
    } catch (error) {
      this.effects.interruptForNarrativeFailure(event, error);
      return false;
    }
  }

  private publishAfterDurability(event: AgentEvent, terminal: boolean): void {
    if (!terminal && !this.effects.isLateHook(event)) {
      this.effects.publish(event);
      return;
    }
    const finalization = this.effects.fileFinalization(event.threadId);
    if (!finalization) {
      this.effects.publish(event);
      return;
    }
    void finalization.then((persisted) => {
      if (persisted) this.effects.publish(event);
    });
  }

  private applyEffect(input: ProviderEventIngressEvent, event: AgentEvent): boolean | undefined {
    this.effects.recordDiagnostic(diagnosticProvenance(input), event);
    const providerId = input.providerId;
    for (const family of this.families(providerId)) {
      const result = family(event);
      if (result !== undefined) return result;
    }
    return true;
  }

  private families(providerId: ProviderId): Array<(event: AgentEvent) => boolean | undefined> {
    return [
      (event) => event.type === AgentEventType.TextDelta ? this.effects.applyTextDelta(event) : undefined,
      (event) => event.type === AgentEventType.GeneratedAttachment ? this.effects.applyGeneratedAttachment(event) : undefined,
      (event) => event.type === AgentEventType.Message ? this.effects.applyMessage(providerId, event) : undefined,
      (event) => event.type === AgentEventType.AssistantMessageBoundary ? this.effects.applyAssistantMessageBoundary(event) : undefined,
      (event) => event.type === AgentEventType.ToolUse ? this.effects.applyToolUse(event) : undefined,
      (event) => event.type === AgentEventType.HookStarted ? this.effects.applyHookStarted(event) : undefined,
      (event) => event.type === AgentEventType.HookCompleted ? this.effects.applyHookCompleted(event) : undefined,
      (event) => event.type === AgentEventType.ToolResult ? this.effects.applyToolResult(event) : undefined,
      (event) => event.type === AgentEventType.TurnStarted ? this.effects.applyTurnStarted(event) : undefined,
      (event) => event.type === AgentEventType.TurnComplete ? this.effects.applyTurnComplete(event) : undefined,
      (event) => event.type === AgentEventType.Error ? this.effects.applyError(event) : undefined,
      (event) => event.type === AgentEventType.Compacting ? this.effects.applyCompacting(event) : undefined,
      (event) => event.type === AgentEventType.CompactSummary ? this.effects.applyCompactSummary(event) : undefined,
      (event) => event.type === AgentEventType.System ? this.effects.applySystem(providerId, event) : undefined,
      (event) => event.type === AgentEventType.Ended ? this.effects.applyEnded(event) : undefined,
    ];
  }
}

function diagnosticProvenance(input: ProviderEventIngressEvent): TurnEventDiagnosticProvenance {
  const receipt = input.canonicalReceipt;
  if (!receipt) return { sourceKind: input.sourceKind };
  return {
    sourceKind: input.sourceKind,
    canonicalReceipt: {
      eventId: receipt.eventId,
      durableRevision: receipt.durableRevision,
    },
  };
}

function isTerminal(event: AgentEvent): boolean {
  return event.type === AgentEventType.TurnComplete
    || event.type === AgentEventType.Error
    || (event.type === AgentEventType.Ended && event.outcome !== undefined);
}

function isUnsavedNarrationBoundary(event: AgentEvent, effects: TurnEventEffects): boolean {
  return event.type === AgentEventType.AssistantMessageBoundary
    && event.isFinalResponse === false
    && event.turnExecutionId !== undefined
    && effects.isAssistantTextUnsaved(event.turnExecutionId);
}
