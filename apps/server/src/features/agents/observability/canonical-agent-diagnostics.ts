/** Maximum content-free diagnostic entries retained in memory. */
export const CANONICAL_DIAGNOSTIC_RING_CAPACITY = 128;
/** Maximum raw events retained for one explicitly selected turn. */
export const CANONICAL_RAW_CAPTURE_EVENT_CAPACITY = 128;
/** Maximum serialized raw content retained for one selected turn. */
export const CANONICAL_RAW_CAPTURE_MAX_BYTES = 256 * 1_024;
/** Maximum lifetime for an explicitly selected raw capture. */
export const CANONICAL_RAW_CAPTURE_MAX_TTL_MS = 15 * 60 * 1_000;
const CANONICAL_DIAGNOSTIC_CONTENT_BYTES_MAX = 1_024 * 1_024;
const CANONICAL_DIAGNOSTIC_TRAVERSAL_MAX_NODES = 1_024;
const CANONICAL_DIAGNOSTIC_TRAVERSAL_MAX_DEPTH = 8;
const CANONICAL_DIAGNOSTIC_TURN_COUNTER_CAPACITY = 128;
const CANONICAL_RAW_CAPTURE_TURN_CAPACITY = 16;

/** One content-free diagnostic observation. */
export interface CanonicalDiagnosticRecordInput {
  turnId: string;
  executionId: string;
  source: "provider" | "canonical";
  event: unknown;
  terminal?: boolean;
}

/** Redacted metadata retained for one provider or canonical event. */
export interface CanonicalDiagnosticEntry {
  turnId: string;
  executionId: string;
  source: "provider" | "canonical";
  eventType: string;
  contentBytes: number;
  contentTruncated: boolean;
  redacted: true;
  recordedAt: string;
}

/** Bounded turn diagnostic export with optional confirmed raw content. */
export interface CanonicalDiagnosticExport {
  entries: CanonicalDiagnosticEntry[];
  truncation: { droppedEntries: number };
  rawEvents?: unknown[];
  rawTruncation?: { droppedEvents: number };
}

interface RawCapture {
  expiresAt: number;
  active: boolean;
  events: unknown[];
  bytes: number;
  droppedEvents: number;
}

const CONTENT_KEYS = new Set([
  "content",
  "delta",
  "error",
  "failureReason",
  "output",
  "partialJson",
  "reason",
  "summary",
  "toolInput",
]);

function eventType(event: unknown): string {
  if (!event || typeof event !== "object" || !("type" in event)) return "unknown";
  return typeof event.type === "string" ? event.type : "unknown";
}

interface ContentMeasureState {
  bytes: number;
  visited: number;
  truncated: boolean;
}

interface PendingContentValue {
  value: unknown;
  key?: string;
  depth: number;
}

function canMeasureContentValue(current: PendingContentValue, state: ContentMeasureState): boolean {
  state.visited += 1;
  if (
    state.visited > CANONICAL_DIAGNOSTIC_TRAVERSAL_MAX_NODES
    || current.depth > CANONICAL_DIAGNOSTIC_TRAVERSAL_MAX_DEPTH
  ) {
    state.truncated = true;
    return false;
  }
  return true;
}

function measureStringContent(current: PendingContentValue, state: ContentMeasureState): void {
  if (typeof current.value !== "string" || !current.key || !CONTENT_KEYS.has(current.key)) return;
  const nextBytes = state.bytes + Buffer.byteLength(current.value, "utf8");
  if (nextBytes > CANONICAL_DIAGNOSTIC_CONTENT_BYTES_MAX) state.truncated = true;
  state.bytes = Math.min(CANONICAL_DIAGNOSTIC_CONTENT_BYTES_MAX, nextBytes);
}

function appendArrayContent(
  value: unknown[],
  current: PendingContentValue,
  state: ContentMeasureState,
  pending: PendingContentValue[],
): void {
  const remaining = CANONICAL_DIAGNOSTIC_TRAVERSAL_MAX_NODES - state.visited - pending.length;
  const limit = Math.max(0, Math.min(value.length, remaining));
  for (let index = 0; index < limit; index += 1) {
    pending.push({ value: value[index], key: current.key, depth: current.depth + 1 });
  }
  if (limit < value.length) state.truncated = true;
}

function appendObjectContent(
  value: Record<string, unknown>,
  current: PendingContentValue,
  state: ContentMeasureState,
  pending: PendingContentValue[],
): void {
  let added = 0;
  const remaining = CANONICAL_DIAGNOSTIC_TRAVERSAL_MAX_NODES - state.visited - pending.length;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (added >= remaining) {
      state.truncated = true;
      break;
    }
    pending.push({ value: value[key], key, depth: current.depth + 1 });
    added += 1;
  }
}

function measureContent(value: unknown): { bytes: number; truncated: boolean } {
  const pending: PendingContentValue[] = [{ value, depth: 0 }];
  const state: ContentMeasureState = { bytes: 0, visited: 0, truncated: false };
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!canMeasureContentValue(current, state)) continue;
    if (typeof current.value === "string") {
      measureStringContent(current, state);
      continue;
    }
    if (Array.isArray(current.value)) {
      appendArrayContent(current.value, current, state, pending);
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    appendObjectContent(current.value as Record<string, unknown>, current, state, pending);
  }
  return { bytes: state.bytes, truncated: state.truncated };
}

function serializeRawEvent(event: unknown): { event: unknown; bytes: number } | null {
  const serialized = JSON.stringify(event);
  if (serialized === undefined) return null;
  return {
    event: JSON.parse(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/** Retains bounded redacted diagnostics and consent-scoped raw turn captures. */
export class CanonicalAgentDiagnostics {
  private readonly entries: CanonicalDiagnosticEntry[] = [];
  private readonly droppedByTurn = new Map<string, number>();
  private readonly rawCaptures = new Map<string, RawCapture>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Start one bounded raw capture after explicit user consent. */
  startRawCapture(input: { turnId: string; consent: boolean; expiresInMs: number }): void {
    if (!input.consent) throw new Error("Raw capture requires explicit consent");
    if (!Number.isFinite(input.expiresInMs) || input.expiresInMs <= 0) {
      throw new Error("Raw capture expiry must be positive");
    }
    this.sweepExpiredRawCaptures();
    if (!this.rawCaptures.has(input.turnId)
      && this.rawCaptures.size >= CANONICAL_RAW_CAPTURE_TURN_CAPACITY) {
      const oldestTurnId = this.rawCaptures.keys().next().value as string | undefined;
      if (oldestTurnId) this.rawCaptures.delete(oldestTurnId);
    }
    const expiresInMs = Math.min(input.expiresInMs, CANONICAL_RAW_CAPTURE_MAX_TTL_MS);
    this.rawCaptures.set(input.turnId, {
      expiresAt: this.now() + expiresInMs,
      active: true,
      events: [],
      bytes: 0,
      droppedEvents: 0,
    });
  }

  /** Record one event without retaining content unless raw capture is active. */
  record(input: CanonicalDiagnosticRecordInput): void {
    const measuredContent = measureContent(input.event);
    const entry: CanonicalDiagnosticEntry = {
      turnId: input.turnId,
      executionId: input.executionId,
      source: input.source,
      eventType: eventType(input.event),
      contentBytes: measuredContent.bytes,
      contentTruncated: measuredContent.truncated,
      redacted: true,
      recordedAt: new Date(this.now()).toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > CANONICAL_DIAGNOSTIC_RING_CAPACITY) {
      const [dropped] = this.entries.splice(0, 1);
      if (dropped) {
        this.incrementDroppedEntries(dropped.turnId);
      }
    }

    const raw = this.rawCaptures.get(input.turnId);
    if (!raw) return;
    if (raw.expiresAt <= this.now()) {
      this.rawCaptures.delete(input.turnId);
      return;
    }
    if (raw.active) {
      const serialized = serializeRawEvent(input.event);
      if (serialized
        && raw.events.length < CANONICAL_RAW_CAPTURE_EVENT_CAPACITY
        && raw.bytes + serialized.bytes <= CANONICAL_RAW_CAPTURE_MAX_BYTES) {
        raw.events.push(serialized.event);
        raw.bytes += serialized.bytes;
      } else {
        raw.droppedEvents += 1;
      }
    }
    if (input.terminal) raw.active = false;
  }

  /** Export redacted diagnostics and, after separate confirmation, raw content. */
  exportTurn(
    turnId: string,
    options: { includeRaw?: boolean; confirmRaw?: boolean } = {},
  ): CanonicalDiagnosticExport {
    const result: CanonicalDiagnosticExport = {
      entries: this.entries.filter((entry) => entry.turnId === turnId),
      truncation: { droppedEntries: this.droppedByTurn.get(turnId) ?? 0 },
    };
    if (!options.includeRaw) return result;
    if (!options.confirmRaw) throw new Error("Raw export requires separate confirmation");

    const raw = this.rawCaptures.get(turnId);
    this.rawCaptures.delete(turnId);
    if (!raw || raw.expiresAt <= this.now()) {
      return { ...result, rawEvents: [], rawTruncation: { droppedEvents: 0 } };
    }
    return {
      ...result,
      rawEvents: [...raw.events],
      rawTruncation: { droppedEvents: raw.droppedEvents },
    };
  }

  private incrementDroppedEntries(turnId: string): void {
    const nextCount = (this.droppedByTurn.get(turnId) ?? 0) + 1;
    this.droppedByTurn.delete(turnId);
    this.droppedByTurn.set(turnId, nextCount);
    if (this.droppedByTurn.size <= CANONICAL_DIAGNOSTIC_TURN_COUNTER_CAPACITY) return;
    const oldestTurnId = this.droppedByTurn.keys().next().value as string | undefined;
    if (oldestTurnId) this.droppedByTurn.delete(oldestTurnId);
  }

  private sweepExpiredRawCaptures(): void {
    const now = this.now();
    for (const [turnId, capture] of this.rawCaptures) {
      if (capture.expiresAt <= now) this.rawCaptures.delete(turnId);
    }
  }
}
