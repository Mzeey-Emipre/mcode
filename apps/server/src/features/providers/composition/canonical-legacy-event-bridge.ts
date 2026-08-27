import { injectable } from "tsyringe";
import {
  AgentEventSchema,
  ProviderIdSchema,
  type AgentEvent,
  type CanonicalAgentEventEnvelope,
  type ProviderId,
} from "@mcode/contracts";

/** Receives legacy events projected from committed canonical provider items. */
export type CanonicalLegacyEventConsumer = (providerId: ProviderId, event: AgentEvent) => void;

/** Delivers committed canonical live-event projections to legacy provider consumers. */
@injectable()
export class CanonicalLegacyEventBridge {
  private consumer: CanonicalLegacyEventConsumer | undefined;

  /** Register the one legacy event consumer. */
  register(consumer: CanonicalLegacyEventConsumer): void {
    if (this.consumer) {
      throw new Error("Canonical legacy event consumer already registered");
    }
    this.consumer = consumer;
  }

  /** Synchronously project committed provider items into legacy agent events. */
  deliver(envelopes: readonly CanonicalAgentEventEnvelope[]): void {
    if (!this.consumer) return;
    for (const envelope of envelopes) {
      const event = this.project(envelope);
      const providerId = ProviderIdSchema.safeParse(envelope.sourceProviderId);
      if (event && providerId.success) this.consumer(providerId.data, event);
    }
  }

  private project(envelope: CanonicalAgentEventEnvelope): AgentEvent | null {
    if (envelope.payload.type !== "item.recorded") return null;
    const { item } = envelope.payload;
    if (
      envelope.routing.threadId !== item.threadId
      || envelope.routing.turnId !== item.turnId
      || envelope.routing.itemId !== item.id
      || item.payload.projection !== "agentLiveEvent"
    ) {
      return null;
    }
    const parsed = AgentEventSchema().safeParse(item.payload.event);
    if (!parsed.success) return null;
    const event = parsed.data;
    if (
      event.threadId !== envelope.routing.threadId
      || event.turnExecutionId !== envelope.routing.executionId
    ) {
      return null;
    }
    return event;
  }
}
