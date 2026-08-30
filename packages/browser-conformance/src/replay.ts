import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BROWSER_CONFORMANCE_GENERATOR_VERSION,
  BROWSER_CONFORMANCE_SCENARIO_VERSION,
  type BrowserConformanceEventKind,
  type BrowserConformanceNormalizedRun,
  type BrowserConformanceRevisionKey,
  type BrowserConformanceScenario,
  type BrowserConformanceSchedule,
  type BrowserConformanceCleanupInvariant,
  type BrowserConformanceOrder,
  type BrowserConformanceJsonValue,
  type BrowserConformanceResourceSnapshot,
} from "./model.js";
import type { BrowserConformanceCleanupComparison } from "./cleanup.js";

/** Relative directory reserved for disposable conformance replay evidence. */
export const BROWSER_CONFORMANCE_REPLAY_DIRECTORY = ".dev/verification/browser-conformance";

/** Maximum serialized UTF-8 bytes retained by one replay bundle. */
export const BROWSER_CONFORMANCE_REPLAY_MAX_BYTES = 256 * 1_024;

/** Maximum nested value depth retained by replay sanitization. */
export const BROWSER_CONFORMANCE_REPLAY_MAX_DEPTH = 8;

/** Maximum array elements retained by replay sanitization. */
export const BROWSER_CONFORMANCE_REPLAY_MAX_ITEMS = 128;

/** Input to the bounded replay bundle builder. */
export interface BrowserConformanceReplayBundleInput {
  readonly scenario: BrowserConformanceScenario;
  readonly run: BrowserConformanceNormalizedRun;
  readonly cleanup: BrowserConformanceCleanupInvariant & {
    readonly final: BrowserConformanceResourceSnapshot;
    readonly comparison?: BrowserConformanceCleanupComparison;
  };
  readonly failingInvariant: string;
  readonly injectedFault?: { readonly kind: string; readonly order?: BrowserConformanceOrder };
}

/** Sanitized replay command summary with no raw arguments or typed content. */
export interface BrowserConformanceReplayCommand {
  readonly id: string;
  readonly operation: string;
}

/** Sanitized replay event summary with no arbitrary event payload. */
export interface BrowserConformanceReplayEvent {
  readonly order: BrowserConformanceOrder;
  readonly kind: BrowserConformanceEventKind;
  readonly revision?: BrowserConformanceRevisionKey;
}

/** Bounded, sanitized replay representation safe for disposable evidence. */
export interface BrowserConformanceReplayBundle {
  readonly schemaVersion: typeof BROWSER_CONFORMANCE_SCENARIO_VERSION;
  readonly generatorVersion: typeof BROWSER_CONFORMANCE_GENERATOR_VERSION;
  readonly scenarioId: string;
  readonly seed: number;
  readonly commands: readonly BrowserConformanceReplayCommand[];
  readonly schedule: {
    readonly events: readonly BrowserConformanceReplayEvent[];
    readonly checkpoints: readonly { readonly id: string; readonly order: BrowserConformanceOrder; readonly label: string }[];
  };
  readonly run: BrowserConformanceNormalizedRun;
  readonly cleanup: {
    readonly baseline: BrowserConformanceResourceSnapshot;
    readonly final: BrowserConformanceResourceSnapshot;
    readonly comparison?: BrowserConformanceCleanupComparison;
  };
  readonly failingInvariant: string;
  readonly injectedFault?: { readonly kind: string; readonly order?: BrowserConformanceOrder };
}

/** Builds a bounded replay bundle while omitting sensitive and dynamic fields. */
export function createBrowserConformanceReplayBundle(
  input: BrowserConformanceReplayBundleInput,
): BrowserConformanceReplayBundle {
  const schedule = sanitizeSchedule(input.scenario.schedule);
  const bundle: BrowserConformanceReplayBundle = {
    schemaVersion: BROWSER_CONFORMANCE_SCENARIO_VERSION,
    generatorVersion: BROWSER_CONFORMANCE_GENERATOR_VERSION,
    scenarioId: sanitizeLabel(input.scenario.id),
    seed: input.scenario.seed,
    commands: input.scenario.commands.slice(0, input.scenario.schedule.bounds.maxCommands).map((command) => ({
      id: sanitizeLabel(command.id),
      operation: command.operation,
    })),
    schedule,
    run: sanitizeBrowserConformanceValue(input.run) as unknown as BrowserConformanceNormalizedRun,
    cleanup: {
      baseline: sanitizeBrowserConformanceValue(input.cleanup.baseline) as unknown as BrowserConformanceResourceSnapshot,
      final: sanitizeBrowserConformanceValue(input.cleanup.final) as unknown as BrowserConformanceResourceSnapshot,
      ...(input.cleanup.comparison
        ? { comparison: sanitizeBrowserConformanceValue(input.cleanup.comparison) as unknown as BrowserConformanceCleanupComparison }
        : {}),
    },
    failingInvariant: sanitizeInvariant(input.failingInvariant),
    ...(input.injectedFault
      ? {
          injectedFault: {
            kind: sanitizeLabel(input.injectedFault.kind),
            ...(input.injectedFault.order ? { order: input.injectedFault.order } : {}),
          },
        }
      : {}),
  };
  return fitReplayBundle(bundle);
}

/** Serializes a replay bundle and enforces its UTF-8 size bound. */
export function serializeBrowserConformanceReplayBundle(
  bundle: BrowserConformanceReplayBundle,
): string {
  const serialized = JSON.stringify(sanitizeBrowserConformanceValue(bundle));
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > BROWSER_CONFORMANCE_REPLAY_MAX_BYTES) {
    throw new RangeError(`Browser conformance replay exceeds ${BROWSER_CONFORMANCE_REPLAY_MAX_BYTES} bytes`);
  }
  return serialized;
}

/** Writes one replay bundle below the disposable verification directory. */
export async function writeBrowserConformanceReplayBundle(
  bundle: BrowserConformanceReplayBundle,
  options: { readonly workspaceRoot: string; readonly fileName?: string },
): Promise<string> {
  const fileName = safeFileName(options.fileName ?? `replay-${bundle.seed}.json`);
  const directory = resolve(options.workspaceRoot, BROWSER_CONFORMANCE_REPLAY_DIRECTORY);
  const filePath = join(directory, fileName);
  if (!filePath.startsWith(`${directory}\\`) && !filePath.startsWith(`${directory}/`)) {
    throw new RangeError("Replay path must remain inside the conformance verification directory");
  }
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, serializeBrowserConformanceReplayBundle(bundle), "utf8");
  return filePath;
}

/** Sanitizes arbitrary diagnostics into bounded JSON without credentials or raw content. */
export function sanitizeBrowserConformanceValue(value: unknown): BrowserConformanceJsonValue {
  return sanitizeValue(value, 0, new WeakSet<object>(), undefined);
}

function sanitizeSchedule(schedule: BrowserConformanceSchedule): BrowserConformanceReplayBundle["schedule"] {
  return {
    events: schedule.events.slice(0, schedule.bounds.maxEvents).map((event) => ({
      order: event.order,
      kind: event.kind,
      ...(event.revision ? { revision: event.revision } : {}),
    })),
    checkpoints: schedule.checkpoints.slice(0, schedule.bounds.maxCheckpoints).map((checkpoint) => ({
      id: sanitizeLabel(checkpoint.id),
      order: checkpoint.order,
      label: sanitizeLabel(checkpoint.label),
    })),
  };
}

function sanitizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  key: string | undefined,
): BrowserConformanceJsonValue {
  const marker = sanitizerMarker(depth, key);
  if (marker) return marker;
  const primitive = sanitizePrimitive(value, key);
  if (primitive !== undefined) return primitive;
  if (typeof value !== "object" || value === null) return null;
  return sanitizeObjectValue(value, depth, seen);
}

function sanitizerMarker(depth: number, key: string | undefined): string | undefined {
  if (depth > BROWSER_CONFORMANCE_REPLAY_MAX_DEPTH) return "[DEPTH_LIMIT]";
  return key && isSensitiveKey(key) ? "[REDACTED]" : undefined;
}

function sanitizePrimitive(value: unknown, key: string | undefined): BrowserConformanceJsonValue | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value, key);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return undefined;
}

function sanitizeObjectValue(value: object, depth: number, seen: WeakSet<object>): BrowserConformanceJsonValue {
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const sanitized = Array.isArray(value)
    ? sanitizeArray(value, depth, seen)
    : sanitizeObject(value, depth, seen);
  seen.delete(value);
  return sanitized;
}

function sanitizeArray(value: readonly unknown[], depth: number, seen: WeakSet<object>): readonly BrowserConformanceJsonValue[] {
  return value
    .slice(0, BROWSER_CONFORMANCE_REPLAY_MAX_ITEMS)
    .map((item) => sanitizeValue(item, depth + 1, seen, undefined));
}

function sanitizeObject(value: object, depth: number, seen: WeakSet<object>): Record<string, BrowserConformanceJsonValue> {
  const result: Record<string, BrowserConformanceJsonValue> = {};
  for (const objectKey of Object.keys(value).sort().slice(0, BROWSER_CONFORMANCE_REPLAY_MAX_ITEMS)) {
    if (isSensitiveKey(objectKey)) continue;
    result[objectKey] = sanitizeValue((value as Record<string, unknown>)[objectKey], depth + 1, seen, objectKey);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /^(args?|typed[_-]?text|screenshots?|screenshot[_-]?data|body|bodies|headers?|credentials?|cookie|authorization|password|token|secret|query|fragment|errors?|exception|stack|cause|payload)$/i.test(key)
    || /(?:timestamp|requestid|traceid|sessionid|runtimeid|targetid|windowid|nonce|createdat|updatedat|receivedat)$/i.test(key);
}

function fitReplayBundle(bundle: BrowserConformanceReplayBundle): BrowserConformanceReplayBundle {
  let candidate = bundle;
  while (serializedReplayBytes(candidate) > BROWSER_CONFORMANCE_REPLAY_MAX_BYTES) {
    if (candidate.run.receipts.length > 0) {
      candidate = { ...candidate, run: { ...candidate.run, receipts: candidate.run.receipts.slice(0, Math.floor(candidate.run.receipts.length / 2)) } };
      continue;
    }
    if (candidate.run.visibleObservations.length > 0) {
      candidate = { ...candidate, run: { ...candidate.run, visibleObservations: candidate.run.visibleObservations.slice(0, Math.floor(candidate.run.visibleObservations.length / 2)) } };
      continue;
    }
    if (candidate.schedule.events.length > 0) {
      candidate = { ...candidate, schedule: { ...candidate.schedule, events: candidate.schedule.events.slice(0, Math.floor(candidate.schedule.events.length / 2)) } };
      continue;
    }
    if (candidate.schedule.checkpoints.length > 0) {
      candidate = { ...candidate, schedule: { ...candidate.schedule, checkpoints: candidate.schedule.checkpoints.slice(0, Math.floor(candidate.schedule.checkpoints.length / 2)) } };
      continue;
    }
    if (candidate.cleanup.comparison) {
      const { comparison: _comparison, ...cleanup } = candidate.cleanup;
      candidate = { ...candidate, cleanup };
      continue;
    }
    const compacted = compactReplayResources(candidate);
    if (compacted !== candidate) {
      candidate = compacted;
      continue;
    }
    throw new RangeError("Browser conformance replay cannot fit its required evidence fields");
  }
  return candidate;
}

function serializedReplayBytes(bundle: BrowserConformanceReplayBundle): number {
  return new TextEncoder().encode(JSON.stringify(sanitizeBrowserConformanceValue(bundle))).byteLength;
}

function compactReplayResources(bundle: BrowserConformanceReplayBundle): BrowserConformanceReplayBundle {
  const compact = (snapshot: BrowserConformanceResourceSnapshot): BrowserConformanceResourceSnapshot => ({
    ...snapshot,
    identities: Object.fromEntries(Object.keys(snapshot.identities).map((key) => [key, []])) as unknown as BrowserConformanceResourceSnapshot["identities"],
  });
  const baseline = compact(bundle.cleanup.baseline);
  const final = compact(bundle.cleanup.final);
  if (JSON.stringify(baseline) === JSON.stringify(bundle.cleanup.baseline)
    && JSON.stringify(final) === JSON.stringify(bundle.cleanup.final)) return bundle;
  return { ...bundle, cleanup: { ...bundle.cleanup, baseline, final } };
}

function sanitizeString(value: string, key: string | undefined): string {
  if (key && /(?:url|location|href|address)/i.test(key)) {
    try {
      const parsed = new URL(value);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().slice(0, 2_048);
    } catch {
      return "[INVALID_LOCATION]";
    }
  }
  return value
    .replace(/\b(password|token|secret|authorization|cookie|credential|api[_-]?key)\b\s*[:=]\s*[^,;\s]+/gi, "$1=[REDACTED]")
    .slice(0, 2_048);
}

function sanitizeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 128) || "unknown";
}

function sanitizeInvariant(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(?:https?|wss?):\/\/[^\s,;]+/gi, (location) => sanitizeString(location, "url"))
    .replace(/\b(password|token|secret|authorization|cookie|credential|api[_-]?key)\b\s*[:=]\s*[^,;\s]+/gi, "$1=[REDACTED]")
    .slice(0, 256) || "unknown invariant";
}

function safeFileName(value: string): string {
  const fileName = value.replace(/[^A-Za-z0-9_.-]+/g, "_");
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("..")) {
    throw new RangeError("Replay file name is invalid");
  }
  return fileName.endsWith(".json") ? fileName : `${fileName}.json`;
}
