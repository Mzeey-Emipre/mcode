import {
  CanonicalAgentEventEnvelopeSchema,
  CanonicalAgentEventSchema,
  type CanonicalAgentEventEnvelope,
} from "@mcode/agent-model";
import type {
  ProviderEventBatch,
  ProviderEventSinkPort,
  ProviderEventSubmissionReceipt,
} from "../host-ports.js";
import type { DeterministicSinkSnapshot } from "./types.js";

const TERMINAL_TYPES = new Set([
  "turn.completed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.errored",
  "ingest.overflow",
]);

/** Deterministic server sink for offline Provider factory conformance. */
export class DeterministicCanonicalSink implements ProviderEventSinkPort {
  private readonly accepted: CanonicalAgentEventEnvelope[] = [];
  private readonly acceptedDrafts = new Map<string, string>();
  private readonly diagnosticEntries: string[] = [];
  private terminalType: string | null = null;

  constructor(
    private readonly limits: { maxEvents: number; maxDiagnostics: number } = {
      maxEvents: 1_000,
      maxDiagnostics: 32,
    },
  ) {
    if (!Number.isSafeInteger(limits.maxEvents) || limits.maxEvents < 2) {
      throw new TypeError("Deterministic sink maxEvents must reserve terminal capacity");
    }
    if (!Number.isSafeInteger(limits.maxDiagnostics) || limits.maxDiagnostics < 1) {
      throw new TypeError("Deterministic sink maxDiagnostics is invalid");
    }
  }

  /** Accepts one bounded batch and assigns canonical ordering and timestamps. */
  async submit(batch: ProviderEventBatch): Promise<ProviderEventSubmissionReceipt> {
    if (!batch || typeof batch !== "object" || !Array.isArray(batch.events)) {
      throw new TypeError("Deterministic sink batch is invalid");
    }
    const acceptedBefore = this.accepted.length;
    for (const draft of batch.events) {
      CanonicalAgentEventSchema.parse(draft.payload);
      if (draft.routing.threadId !== batch.threadId || draft.routing.turnId !== batch.turnId || draft.routing.executionId !== batch.executionId) {
        throw new TypeError("Provider event routing does not match its batch");
      }
      const fingerprint = JSON.stringify(draft);
      const prior = this.acceptedDrafts.get(draft.eventId);
      if (prior !== undefined) {
        if (prior !== fingerprint) throw new TypeError(`Conflicting replay for Provider event ${draft.eventId}`);
        continue;
      }
      if (this.terminalType !== null) {
        this.addDiagnostic(`Ignored event ${draft.payload.type} after ${this.terminalType}`);
        continue;
      }
      if (this.accepted.length >= this.limits.maxEvents - 1) {
        this.acceptOverflow(batch, draft.sourceProviderId);
        break;
      }
      this.acceptedDrafts.set(draft.eventId, fingerprint);
      if (TERMINAL_TYPES.has(draft.payload.type)) this.terminalType = draft.payload.type;
      this.acceptEnvelope(draft);
    }
    return {
      commit: {
        outcome: this.terminalType === "ingest.overflow"
          ? "ingest-overflow"
          : this.accepted.length === acceptedBefore
            ? "duplicate"
            : "committed",
        conversationRevision: this.accepted.length,
        rosterRevision: 0,
        acceptedThrough: this.accepted.length,
        durableThrough: this.accepted.length,
        eventCount: this.accepted.length - acceptedBefore,
      },
      delivery: { ingress: "queued" },
    };
  }

  /** Returns an immutable snapshot of accepted events and bounded diagnostics. */
  snapshot(): DeterministicSinkSnapshot {
    return {
      events: Object.freeze([...this.accepted]),
      diagnostics: Object.freeze([...this.diagnosticEntries]),
    };
  }

  private acceptEnvelope(draft: ProviderEventBatch["events"][number]): void {
    const acceptedSequence = this.accepted.length + 1;
    const timestamp = new Date(acceptedSequence * 1_000).toISOString();
    const envelope = CanonicalAgentEventEnvelopeSchema.parse({
      ...draft,
      acceptedSequence,
      durableRevision: acceptedSequence,
      serverTimestamps: { acceptedAt: timestamp, persistedAt: timestamp },
    });
    this.accepted.push(envelope);
  }

  private acceptOverflow(batch: ProviderEventBatch, providerId: string): void {
    if (this.terminalType !== null) return;
    this.terminalType = "ingest.overflow";
    this.acceptEnvelope({
      eventId: `overflow:${batch.executionId}`,
      routing: {
        threadId: batch.threadId,
        turnId: batch.turnId,
        executionId: batch.executionId,
      },
      sourceProviderId: providerId,
      sourceIdentities: [],
      payload: {
        type: "ingest.overflow",
        endedAt: new Date((this.accepted.length + 1) * 1_000).toISOString(),
        acceptedStoppingSequence: this.accepted.length,
        durableStoppingSequence: this.accepted.length,
      },
    });
  }

  private addDiagnostic(message: string): void {
    if (this.diagnosticEntries.length < this.limits.maxDiagnostics) {
      this.diagnosticEntries.push(message.slice(0, 512));
    }
  }
}
