import {
  BROWSER_CONFORMANCE_OPERATIONS,
  BROWSER_CONFORMANCE_REVISION_KEYS,
  createBrowserConformanceRevisionVector,
  type BrowserConformanceEffect,
  type BrowserConformanceErrorStage,
  type BrowserConformanceFinalState,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceOperation,
  type BrowserConformanceOrder,
  type BrowserConformanceOutcome,
  type BrowserConformanceOutcomeStatus,
  type BrowserConformanceOwnership,
  type BrowserConformanceReadiness,
  type BrowserConformanceReceipt,
  type BrowserConformanceReceiptStatus,
  type BrowserConformanceRecovery,
  type BrowserConformanceRevisionVector,
  type BrowserConformanceVisibleObservation,
} from "./model.js";
import { createBrowserConformanceResourceSnapshot } from "./cleanup.js";

/** Raw adapter result accepted by the allowlist normalizer. */
export interface BrowserConformanceRawRun {
  readonly receipts?: readonly unknown[];
  readonly outcome?: unknown;
  readonly finalState?: unknown;
  readonly visibleObservations?: readonly unknown[];
}

/** Normalization limits that bound retained receipts and visible observations. */
export interface BrowserConformanceNormalizationOptions {
  readonly maxReceipts?: number;
  readonly maxVisibleObservations?: number;
}

/** Normalizes adapter output while dropping runtime identifiers and dynamic fields. */
export function normalizeBrowserConformanceRun(
  raw: BrowserConformanceRawRun,
  options: BrowserConformanceNormalizationOptions = {},
): BrowserConformanceNormalizedRun {
  const maxReceipts = boundedLimit(options.maxReceipts ?? 128);
  const maxVisibleObservations = boundedLimit(options.maxVisibleObservations ?? 128);
  const receipts = (raw.receipts ?? []).slice(0, maxReceipts).map((receipt, index) => normalizeReceipt(receipt, index));
  const outcome = normalizeOutcome(raw.outcome, receipts.at(-1));
  const finalState = normalizeFinalState(raw.finalState, outcome.revisions);
  const visibleObservations = (raw.visibleObservations ?? [])
    .slice(0, maxVisibleObservations)
    .map(normalizeVisibleObservation);
  return { receipts, outcome, finalState, visibleObservations };
}

/** Normalizes a revision vector and rejects negative or non-integer values. */
export function normalizeBrowserConformanceRevisions(value: unknown): BrowserConformanceRevisionVector {
  const record = asRecord(value);
  const revisions: { -readonly [K in keyof BrowserConformanceRevisionVector]?: number } = {};
  for (const key of BROWSER_CONFORMANCE_REVISION_KEYS) {
    const candidate = record?.[key];
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
      revisions[key] = candidate;
    }
  }
  return createBrowserConformanceRevisionVector(revisions);
}

function normalizeReceipt(value: unknown, index: number): BrowserConformanceReceipt {
  const record = asRecord(value);
  return {
    order: normalizeOrder(readField(record, "order"), index),
    commandId: boundedIdentifier(readField(record, "commandId")),
    operation: normalizeOperation(readField(record, "operation")),
    status: normalizeReceiptStatus(readField(record, "status", "outcome")),
    effect: normalizeEffect(readField(record, "effect")),
    recovery: normalizeRecovery(readField(record, "recovery")),
    truncated: isTruncated(record),
    revisions: normalizeBrowserConformanceRevisions(readField(record, "revisions")),
    errorCode: boundedErrorCode(readField(record, "errorCode", "code")),
    errorStage: normalizeErrorStage(readField(record, "errorStage", "stage")),
    ownership: normalizeOwnership(readField(record, "ownership", "controlOwner")),
  };
}

function normalizeOutcome(value: unknown, receipt: BrowserConformanceReceipt | undefined): BrowserConformanceOutcome {
  const record = asRecord(value);
  return {
    status: normalizeOutcomeStatus(readField(record, "status", "outcome")),
    effect: normalizeEffect(readField(record, "effect")),
    recovery: normalizeRecovery(readField(record, "recovery")),
    truncated: isTruncated(record),
    revisions: normalizeBrowserConformanceRevisions(readField(record, "revisions") ?? receipt?.revisions),
    errorCode: boundedErrorCode(readField(record, "errorCode", "code")),
    errorStage: normalizeErrorStage(readField(record, "errorStage", "stage")),
    ownership: normalizeOwnership(readField(record, "ownership", "controlOwner")),
  };
}

function normalizeFinalState(value: unknown, revisions: BrowserConformanceRevisionVector): BrowserConformanceFinalState {
  const record = asRecord(value);
  const resources = createBrowserConformanceResourceSnapshot(normalizeResources(readField(record, "resources")));
  return {
    readiness: normalizeReadiness(readField(record, "readiness", "state")),
    controlOwner: normalizeOwnership(readField(record, "controlOwner", "ownership")),
    tabCount: normalizeTabCount(record),
    currentUrl: sanitizeLocation(readField(record, "currentUrl", "url")),
    revisions: normalizeBrowserConformanceRevisions(readField(record, "revisions") ?? revisions),
    resources,
  };
}

function normalizeVisibleObservation(value: unknown): BrowserConformanceVisibleObservation {
  const record = asRecord(value);
  return {
    surface: normalizeSurface(readField(record, "surface")),
    readiness: normalizeReadiness(readField(record, "readiness", "state")),
    controlOwner: normalizeOwnership(readField(record, "controlOwner", "ownership")),
    tabCount: normalizeTabCount(record),
    currentUrl: sanitizeLocation(readField(record, "currentUrl", "url")),
    title: boundedText(readField(record, "title", "tabTitle")),
    action: boundedText(readField(record, "action", "operation")),
    truncated: isTruncated(record),
  };
}

function normalizeResources(value: unknown) {
  const record = asRecord(value);
  const counts: Record<string, number> = {};
  const rawIdentities = asRecord(record?.identities);
  const identities: Record<string, readonly { readonly id: string; readonly generation: number }[]> = {};
  for (const key of ["requests", "queues", "timers", "listeners", "heldInput", "controllerLeases", "targets", "replayEntries", "registries", "buffers"]) {
    counts[key] = boundedCount(record?.[key]);
    identities[key] = normalizeResourceIdentities(rawIdentities?.[key]);
  }
  return { counts, identities, revisions: normalizeBrowserConformanceRevisions(record?.revisions) };
}

function normalizeResourceIdentities(value: unknown): readonly { readonly id: string; readonly generation: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 256)
    .map(normalizeResourceIdentity)
    .filter((identity): identity is { readonly id: string; readonly generation: number } => identity !== null);
}

function normalizeResourceIdentity(value: unknown): { readonly id: string; readonly generation: number } | null {
  const item = asRecord(value);
  const id = boundedIdentifier(item?.id);
  return id ? { id, generation: boundedCount(item?.generation) } : null;
}

function readField(record: Record<string, unknown> | null, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function isTruncated(record: Record<string, unknown> | null): boolean {
  return record?.truncated === true || record?.truncation === true;
}

function normalizeTabCount(record: Record<string, unknown> | null): number {
  const tabCount = readField(record, "tabCount");
  if (tabCount !== undefined) return boundedCount(tabCount);
  const tabs = readField(record, "tabs");
  return Array.isArray(tabs) ? boundedCount(tabs.length) : 0;
}

function normalizeOrder(value: unknown, fallbackOrdinal: number): BrowserConformanceOrder {
  const record = asRecord(value);
  return {
    tick: boundedCount(record?.tick),
    ordinal: boundedCount(record?.ordinal ?? fallbackOrdinal),
  };
}

function normalizeOperation(value: unknown): BrowserConformanceOperation | "unknown" {
  if (typeof value !== "string") return "unknown";
  const normalized = value.replace(/^.*browser[_-]/i, "").replace(/[_-]/g, "");
  return BROWSER_CONFORMANCE_OPERATIONS.find((operation) => operation.toLowerCase() === normalized.toLowerCase()) ?? "unknown";
}

function normalizeReceiptStatus(value: unknown): BrowserConformanceReceiptStatus {
  return isOneOf(value, ["applied", "satisfied", "failed", "interrupted", "skipped", "unknown"])
    ? value
    : "unknown";
}

function normalizeOutcomeStatus(value: unknown): BrowserConformanceOutcomeStatus {
  return isOneOf(value, ["completed", "failed", "interrupted", "unknown"]) ? value : "unknown";
}

function normalizeEffect(value: unknown): BrowserConformanceEffect {
  return isOneOf(value, ["none", "partial", "complete", "created", "closed", "preserved", "unknown"])
    ? value
    : "unknown";
}

function normalizeRecovery(value: unknown): BrowserConformanceRecovery {
  return isOneOf(value, ["none", "retry", "refresh", "reopen", "manual", "inspect", "wait", "yield_to_user", "do_not_retry", "unknown"])
    ? value
    : "unknown";
}

function normalizeErrorStage(value: unknown): BrowserConformanceErrorStage {
  return isOneOf(value, ["validation", "admission", "dispatch", "effect", "observation", "cleanup", "unknown"])
    ? value
    : "unknown";
}

function normalizeOwnership(value: unknown): BrowserConformanceOwnership {
  return isOneOf(value, ["none", "agent", "user", "shared", "unknown"]) ? value : "unknown";
}

function normalizeReadiness(value: unknown): BrowserConformanceReadiness {
  return isOneOf(value, ["ready", "host-unavailable", "target-unavailable", "recovering", "human-control", "unknown"])
    ? value
    : "unknown";
}

function normalizeSurface(value: unknown): BrowserConformanceVisibleObservation["surface"] {
  return isOneOf(value, ["browser", "thread-overview", "narrative", "unknown"]) ? value : "unknown";
}

function boundedLimit(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(256, value) : 0;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(1_000_000, value) : 0;
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

function boundedErrorCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_:-]{1,64}$/.test(value) ? value : null;
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" ? value.slice(0, 256) : null;
}

function sanitizeLocation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 2_048);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
