import { logger } from "@mcode/shared";
import {
  CanonicalAgentEventEnvelopeSchema,
  ProviderIdSchema,
  ProviderRuntimeEventSchema,
  type AgentEvent,
  type CanonicalAgentEventEnvelope,
  type IProviderRegistry,
  type ProviderFileMutationStart,
  type ProviderId,
  type ProviderRuntimeEvent,
} from "@mcode/contracts";
import { inject, injectable } from "tsyringe";

import {
  CODEX_PROVIDER_EVENT_ADAPTER,
  type ProviderEventAdapter,
} from "./provider-event-adapter.js";

const MAX_PENDING_PROVIDER_EVENTS = 1_024;
const MAX_CANONICAL_EVENT_IDENTITIES = 16_384;

/** Injection token for the content-free provider ingress diagnostic sink. */
export const PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK = Symbol("ProviderEventIngressDiagnosticSink");

/** Identifies the transport path that delivered one provider runtime event. */
export type ProviderEventSourceKind = "provider-runtime" | "canonical-commit";

/** Durable canonical metadata that must remain attached to a projected live event. */
export interface CanonicalProviderEventReceipt {
  eventId: string;
  sourceSequence?: number;
  acceptedSequence: number;
  durableRevision: number;
  serverTimestamps: CanonicalAgentEventEnvelope["serverTimestamps"];
}

/** One validated provider event before the turn pipeline processes it. */
export interface ProviderEventIngressEvent {
  providerId: ProviderId;
  sourceKind: ProviderEventSourceKind;
  event: AgentEvent;
  runtimeExtension?: ProviderRuntimeEvent["extension"];
  canonicalReceipt?: CanonicalProviderEventReceipt;
}

/** Narrow downstream contract used until TurnEventPipeline owns provider event handling. */
export interface ProviderEventIngressConsumer {
  handleProviderEvent(event: ProviderEventIngressEvent): void;
  handleProviderFileMutation(event: ProviderFileMutationStart): void;
}

/** Content-free diagnostic recorded when ingress rejects an event. */
export interface ProviderEventIngressDiagnostic {
  reason: "invalid-canonical-envelope" | "invalid-runtime-event" | "provider-identity-mismatch" | "runtime-extension-mismatch" | "duplicate-event" | "queue-capacity" | "adapter-rejected";
  sourceKind: ProviderEventSourceKind;
  providerId?: string;
  eventId?: string;
}

/** Receives content-free ingress diagnostics. */
export type ProviderEventIngressDiagnosticSink = (diagnostic: ProviderEventIngressDiagnostic) => void;

/** Log a content-free diagnostic when no application-specific sink is registered. */
export function logProviderEventIngressDiagnostic(diagnostic: ProviderEventIngressDiagnostic): void {
  logger.warn("Provider event ingress rejected event", diagnostic);
}

function canonicalReceipt(envelope: CanonicalAgentEventEnvelope): CanonicalProviderEventReceipt {
  return {
    eventId: envelope.eventId,
    sourceSequence: envelope.sourceSequence,
    acceptedSequence: envelope.acceptedSequence,
    durableRevision: envelope.durableRevision,
    serverTimestamps: envelope.serverTimestamps,
  };
}

function agentEventMatchesProvider(event: AgentEvent, providerId: ProviderId): boolean {
  return !("providerId" in event) || event.providerId === undefined || event.providerId === providerId;
}

/** Owns provider subscriptions, validates inbound delivery, and queues accepted downstream events. */
@injectable()
export class ProviderEventIngress {
  private readonly seenLegacyEvents = new WeakSet<object>();
  private readonly seenCanonicalEventIds = new Map<string, true>();
  private readonly pending: ProviderEventIngressEvent[] = [];
  private consumer: ProviderEventIngressConsumer | undefined;
  private started = false;
  private drainScheduled = false;

  constructor(
    @inject(PROVIDER_EVENT_INGRESS_DIAGNOSTIC_SINK)
    private readonly diagnostics: ProviderEventIngressDiagnosticSink = logProviderEventIngressDiagnostic,
    @inject(CODEX_PROVIDER_EVENT_ADAPTER, { isOptional: true })
    private readonly codexAdapter?: ProviderEventAdapter,
  ) {}

  /** Subscribe once after providers and the downstream event consumer exist. */
  start(providerRegistry: IProviderRegistry, consumer: ProviderEventIngressConsumer): void {
    if (this.started) return;
    this.started = true;
    this.consumer = consumer;
    for (const provider of providerRegistry.resolveAll()) {
      provider.on("file_mutation_start", (event) => consumer.handleProviderFileMutation(event));
      provider.on("event", (event) => this.acceptProviderRuntime(provider.id, event));
    }
  }

  /** Accept one provider-originated runtime event that has no canonical receipt. */
  acceptProviderRuntime(providerId: ProviderId, runtimeEvent: unknown): void {
    const parsedProviderId = ProviderIdSchema.safeParse(providerId);
    if (!parsedProviderId.success) {
      this.report({ reason: "provider-identity-mismatch", sourceKind: "provider-runtime", providerId: String(providerId) });
      return;
    }
    if (!runtimeEvent || typeof runtimeEvent !== "object") {
      this.report({ reason: "invalid-runtime-event", sourceKind: "provider-runtime", providerId: parsedProviderId.data });
      return;
    }
    const parsedRuntimeEvent = this.parseLegacyRuntimeEvent(parsedProviderId.data, runtimeEvent);
    if (!parsedRuntimeEvent) return;
    this.seenLegacyEvents.add(runtimeEvent);
    this.acceptRuntimeEvent({
      providerId: parsedProviderId.data,
      sourceKind: "provider-runtime",
      event: parsedRuntimeEvent.event,
      ...(parsedRuntimeEvent.extension ? { runtimeExtension: parsedRuntimeEvent.extension } : {}),
    });
  }

  private parseLegacyRuntimeEvent(providerId: ProviderId, runtimeEvent: object): ProviderRuntimeEvent | undefined {
    if (this.seenLegacyEvents.has(runtimeEvent)) {
      this.report({ reason: "duplicate-event", sourceKind: "provider-runtime", providerId });
      return undefined;
    }
    const parsed = ProviderRuntimeEventSchema().safeParse(runtimeEvent);
    if (!parsed.success || !agentEventMatchesProvider(parsed.data.event, providerId)) {
      this.report({ reason: "invalid-runtime-event", sourceKind: "provider-runtime", providerId });
      return undefined;
    }
    if (parsed.data.extension?.providerId !== undefined && parsed.data.extension.providerId !== providerId) {
      this.report({ reason: "runtime-extension-mismatch", sourceKind: "provider-runtime", providerId });
      return undefined;
    }
    return parsed.data;
  }

  /** Accept one committed canonical batch and queue its runtime events in receipt order. */
  acceptCommitted(envelopes: readonly CanonicalAgentEventEnvelope[]): void {
    for (const envelope of envelopes) this.acceptCanonicalEnvelope(envelope);
  }

  private acceptCanonicalEnvelope(envelope: unknown): void {
    const parsedEnvelope = CanonicalAgentEventEnvelopeSchema.safeParse(envelope);
    if (!parsedEnvelope.success) {
      this.report({ reason: "invalid-canonical-envelope", sourceKind: "canonical-commit" });
      return;
    }
    const parsedProviderId = ProviderIdSchema.safeParse(parsedEnvelope.data.sourceProviderId);
    if (!parsedProviderId.success) {
      this.report({
        reason: "provider-identity-mismatch",
        sourceKind: "canonical-commit",
        providerId: parsedEnvelope.data.sourceProviderId,
        eventId: parsedEnvelope.data.eventId,
      });
      return;
    }
    const runtimeEvent = this.projectCanonicalRuntimeEvent(parsedEnvelope.data, parsedProviderId.data);
    if (!runtimeEvent) return;
    if (this.seenCanonicalEventIds.has(parsedEnvelope.data.eventId)) {
      this.report({
        reason: "duplicate-event",
        sourceKind: "canonical-commit",
        providerId: parsedProviderId.data,
        eventId: parsedEnvelope.data.eventId,
      });
      return;
    }
    const accepted = this.acceptRuntimeEvent({
      providerId: parsedProviderId.data,
      sourceKind: "canonical-commit",
      event: runtimeEvent.event,
      ...(runtimeEvent.extension ? { runtimeExtension: runtimeEvent.extension } : {}),
      canonicalReceipt: canonicalReceipt(parsedEnvelope.data),
    });
    if (accepted) this.rememberCanonicalEvent(parsedEnvelope.data.eventId);
  }

  private projectCanonicalRuntimeEvent(
    envelope: CanonicalAgentEventEnvelope,
    providerId: ProviderId,
  ): ProviderRuntimeEvent | undefined {
    if (!this.isProviderRuntimeItem(envelope)) return undefined;
    const { item } = envelope.payload;
    const parsedRuntimeEvent = ProviderRuntimeEventSchema().safeParse(item.payload.runtimeEvent);
    if (!parsedRuntimeEvent.success || !this.matchesCanonicalRouting(envelope, item, parsedRuntimeEvent.data, providerId)) {
      this.report({
        reason: "invalid-runtime-event",
        sourceKind: "canonical-commit",
        providerId: envelope.sourceProviderId,
        eventId: envelope.eventId,
      });
      return undefined;
    }
    return parsedRuntimeEvent.data;
  }

  private isProviderRuntimeItem(
    envelope: CanonicalAgentEventEnvelope,
  ): envelope is CanonicalAgentEventEnvelope & {
    payload: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>;
  } {
    return envelope.payload.type === "item.recorded"
      && envelope.payload.item.payload.projection === "providerRuntimeEvent";
  }

  private matchesCanonicalRouting(
    envelope: CanonicalAgentEventEnvelope,
    item: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>['item'],
    runtimeEvent: ProviderRuntimeEvent,
    providerId: ProviderId,
  ): boolean {
    return this.matchesItemRouting(envelope, item)
      && runtimeEvent.event.threadId === envelope.routing.threadId
      && runtimeEvent.event.turnExecutionId === envelope.routing.executionId
      && agentEventMatchesProvider(runtimeEvent.event, providerId)
      && this.matchesRuntimeExtension(runtimeEvent, providerId);
  }

  private matchesItemRouting(
    envelope: CanonicalAgentEventEnvelope,
    item: Extract<CanonicalAgentEventEnvelope["payload"], { type: "item.recorded" }>['item'],
  ): boolean {
    return envelope.routing.threadId === item.threadId
      && envelope.routing.turnId === item.turnId
      && envelope.routing.itemId === item.id;
  }

  private matchesRuntimeExtension(runtimeEvent: ProviderRuntimeEvent, providerId: ProviderId): boolean {
    return runtimeEvent.extension?.providerId === undefined || runtimeEvent.extension.providerId === providerId;
  }

  private acceptRuntimeEvent(event: ProviderEventIngressEvent): boolean {
    const projection = this.adapterFor(event.providerId)?.project(event) ?? { status: "forward" as const, event: event.event };
    if (projection.status === "consumed") return true;
    if (projection.status === "rejected") {
      this.report({
        reason: "adapter-rejected",
        sourceKind: event.sourceKind,
        providerId: event.providerId,
        eventId: event.canonicalReceipt?.eventId,
      });
      return true;
    }
    return this.enqueue({ ...event, event: projection.event });
  }

  private adapterFor(providerId: ProviderId): ProviderEventAdapter | undefined {
    return this.codexAdapter?.providerId === providerId ? this.codexAdapter : undefined;
  }

  private enqueue(event: ProviderEventIngressEvent): boolean {
    if (event.sourceKind === "provider-runtime" && this.consumer && this.pending.length === 0 && !this.drainScheduled) {
      this.consumer?.handleProviderEvent(event);
      return true;
    }
    if (this.pending.length >= MAX_PENDING_PROVIDER_EVENTS) {
      this.report({
        reason: "queue-capacity",
        sourceKind: event.sourceKind,
        providerId: event.providerId,
        eventId: event.canonicalReceipt?.eventId,
      });
      return false;
    }
    this.pending.push(event);
    this.scheduleDrain();
    return true;
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => this.drain());
  }

  private drain(): void {
    this.drainScheduled = false;
    while (this.pending.length > 0) {
      const event = this.pending.shift();
      if (event) this.consumer?.handleProviderEvent(event);
    }
  }

  private rememberCanonicalEvent(eventId: string): void {
    this.seenCanonicalEventIds.set(eventId, true);
    if (this.seenCanonicalEventIds.size > MAX_CANONICAL_EVENT_IDENTITIES) {
      const oldestEventId = this.seenCanonicalEventIds.keys().next().value as string | undefined;
      if (oldestEventId) this.seenCanonicalEventIds.delete(oldestEventId);
    }
  }

  private report(diagnostic: ProviderEventIngressDiagnostic): void {
    this.diagnostics(diagnostic);
  }
}
