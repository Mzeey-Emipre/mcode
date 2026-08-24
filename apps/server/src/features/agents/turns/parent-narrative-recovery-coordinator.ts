import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import type { CanonicalAgentEventSink } from "../canonical/canonical-agent-event-sink.js";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";

interface ParentNarrativeRecoveryCheckpoint {
  persist(): void;
  confirm(): void;
}

/** Commits changed structured narrative records before AgentService publishes their source event. */
export class ParentNarrativeRecoveryCoordinator {
  private readonly fingerprintsByExecution = new Map<string, Map<string, string>>();

  constructor(
    private readonly canonicalSink: CanonicalAgentEventSink,
    private readonly narrativeStore: NarrativeStore,
  ) {}

  /** Commit only the semantic records changed by this accepted provider event. */
  checkpoint(event: AgentEvent): void {
    const checkpoint = this.prepareCheckpoint(event);
    if (!checkpoint) return;
    checkpoint.persist();
    checkpoint.confirm();
  }

  /** Prepare a recovery commit whose dedupe state advances only after its transaction commits. */
  prepareCheckpoint(
    event: AgentEvent,
    snapshot?: readonly ParentNarrativeRecoveryItem[],
  ): ParentNarrativeRecoveryCheckpoint | null {
    if (!this.requiresStructuredRecovery(event) || !event.turnExecutionId) return null;
    if (!this.canonicalSink.loadTurnByExecution(event.turnExecutionId)) return null;
    const snapshots = snapshot ?? this.narrativeStore.recoverySnapshot(event.threadId);

    const fingerprints = this.fingerprintsByExecution.get(event.turnExecutionId) ?? new Map<string, string>();
    const nextFingerprints = new Map<string, string>();
    const currentKeys = new Set(snapshots.map((item) => `${item.kind}:${item.record.id}`));
    const changed = snapshots.filter((item) => {
      const key = `${item.kind}:${item.record.id}`;
      const fingerprint = JSON.stringify(item);
      nextFingerprints.set(key, fingerprint);
      if (fingerprints.get(key) === fingerprint) return false;
      return true;
    });
    const discardedItemIds = [...fingerprints.keys()]
      .filter((key) => !currentKeys.has(key))
      .map((key) => this.canonicalItemId(key));
    if (changed.length === 0 && discardedItemIds.length === 0) return null;
    return {
      persist: () => {
        const committed = this.canonicalSink.recordParentNarrativeRecovery({
          executionId: event.turnExecutionId!,
          items: changed,
          discardedItemIds,
        });
        if (!committed) {
          throw new Error(`Canonical parent turn was not found: ${event.turnExecutionId}`);
        }
      },
      confirm: () => this.fingerprintsByExecution.set(event.turnExecutionId!, nextFingerprints),
    };
  }

  /** Forget volatile dedupe state after a terminal turn releases its buffers. */
  clear(executionId: string | undefined): void {
    if (executionId) this.fingerprintsByExecution.delete(executionId);
  }

  private requiresStructuredRecovery(event: AgentEvent): boolean {
    return event.type === AgentEventType.TextDelta
      || event.type === AgentEventType.AssistantMessageBoundary
      || event.type === AgentEventType.ToolUse
      || event.type === AgentEventType.ToolResult
      || event.type === AgentEventType.HookStarted
      || event.type === AgentEventType.HookCompleted;
  }

  private canonicalItemId(key: string): string {
    const separator = key.indexOf(":");
    const kind = separator < 0 ? "" : key.slice(0, separator);
    const id = separator < 0 ? "" : key.slice(separator + 1);
    if (!kind || !id) throw new Error(`Invalid narrative recovery identity: ${key}`);
    return kind === "toolCall" ? `toolCall:${id}` : `${kind}:${id}`;
  }

}
