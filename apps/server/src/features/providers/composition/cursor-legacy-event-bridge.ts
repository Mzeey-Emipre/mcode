import { injectable } from "tsyringe";
import {
  AgentEventSchema,
  type AgentEvent,
  type CanonicalAgentEventEnvelope,
  type ProviderId,
} from "@mcode/contracts";

/** Receives legacy Cursor events projected from committed canonical item records. */
export type CursorLegacyEventConsumer = (providerId: ProviderId, event: AgentEvent) => void;

/** Delivers valid committed Cursor event projections to the legacy event consumer. */
@injectable()
export class CursorLegacyEventBridge {
  private consumer: CursorLegacyEventConsumer | undefined;

  /** Register the one legacy Cursor event consumer. */
  register(consumer: CursorLegacyEventConsumer): void {
    if (this.consumer) {
      throw new Error("Cursor legacy event consumer already registered");
    }
    this.consumer = consumer;
  }

  /** Synchronously project committed Cursor item records into legacy agent events. */
  deliver(envelopes: readonly CanonicalAgentEventEnvelope[]): void {
    if (!this.consumer) return;
    for (const envelope of envelopes) {
      const event = this.project(envelope);
      if (event) this.consumer("cursor", event);
    }
  }

  private project(envelope: CanonicalAgentEventEnvelope): AgentEvent | null {
    if (envelope.sourceProviderId !== "cursor" || envelope.payload.type !== "item.recorded") {
      return null;
    }
    const { item } = envelope.payload;
    if (
      envelope.routing.threadId !== item.threadId
      || envelope.routing.turnId !== item.turnId
      || envelope.routing.itemId !== item.id
      || item.payload.projection !== "cursorLiveEvent"
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
