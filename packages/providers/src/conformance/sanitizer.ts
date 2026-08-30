import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createProviderFixtureManifest } from "./fixture-safety.js";
import type {
  FixtureExpectedSemantics,
  ProviderConformanceProfile,
  ProviderFixtureManifest,
  SanitizedTraceEvent,
} from "./types.js";

const EVENT_KINDS = new Set<SanitizedTraceEvent["kind"]>(["session", "turn", "item", "terminal"]);
const EVENT_STATUSES = new Set<NonNullable<SanitizedTraceEvent["status"]>>([
  "started",
  "completed",
  "interrupted",
  "errored",
]);
const MAX_RAW_CAPTURE_BYTES = 32 * 1_024 * 1_024;

/** Metadata supplied by the maintainer who reviews one raw capture. */
export interface ProviderFixtureSanitizerMetadata {
  providerId: ProviderFixtureManifest["providerId"];
  cliVersion: string;
  protocolVersion: string;
  provenance: ProviderFixtureManifest["provenance"];
  requiredProfiles: readonly ProviderConformanceProfile[];
  scenario: string;
  expected: FixtureExpectedSemantics;
}

/** Sanitizes one raw JSONL capture into an allowlisted committed fixture. */
export function sanitizeProviderFixtureFile(input: {
  rawFile: string;
  outputFile: string;
  metadata: ProviderFixtureSanitizerMetadata;
}): ProviderFixtureManifest {
  const rawFile = requireContainedPath(input.rawFile, resolve(".conformance-raw"), "raw capture");
  const outputFile = requireContainedPath(
    input.outputFile,
    resolve("src/conformance/fixtures"),
    "fixture output",
  );
  if (statSync(rawFile).size > MAX_RAW_CAPTURE_BYTES) {
    throw new TypeError("Provider raw capture exceeds the size limit");
  }
  const rows = readFileSync(rawFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => sanitizeRawRow(JSON.parse(line) as unknown, index + 1));
  if (rows.length === 0 || rows.length > 10_000) {
    throw new TypeError("Provider raw capture event count is invalid");
  }
  const manifest = createProviderFixtureManifest({
    ...input.metadata,
    redaction: {
      reviewed: true,
      removedFields: ["prompt", "response", "text", "environment", "raw tool output", "absolute paths"],
    },
    input: { events: rows },
  });
  writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return manifest;
}

function sanitizeRawRow(value: unknown, sequence: number): SanitizedTraceEvent {
  const row = requireSanitizableRawRow(value, sequence);
  const event: SanitizedTraceEvent = { kind: requireSanitizedEventKind(row.kind, sequence), sequence };
  addSanitizedAlias(event, "nativeId", row.nativeId, "NATIVE");
  addSanitizedAlias(event, "pairId", row.pairId, "PAIR");
  addSanitizedSize(event, row.size);
  addSanitizedStatus(event, row.status);
  return event;
}

function requireSanitizableRawRow(value: unknown, sequence: number): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Provider raw capture row ${sequence} is invalid`);
  return value as Record<string, unknown>;
}

function requireSanitizedEventKind(value: unknown, sequence: number): SanitizedTraceEvent["kind"] {
  if (typeof value !== "string" || !EVENT_KINDS.has(value as SanitizedTraceEvent["kind"])) {
    throw new TypeError(`Provider raw capture row ${sequence} kind is invalid`);
  }
  return value as SanitizedTraceEvent["kind"];
}

function addSanitizedAlias(
  event: SanitizedTraceEvent,
  key: "nativeId" | "pairId",
  value: unknown,
  prefix: string,
): void {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) event[key] = normalizeAlias(value, prefix);
}

function addSanitizedSize(event: SanitizedTraceEvent, value: unknown): void {
  if (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000_000) event.size = Number(value);
}

function addSanitizedStatus(event: SanitizedTraceEvent, value: unknown): void {
  if (typeof value === "string" && EVENT_STATUSES.has(value as NonNullable<SanitizedTraceEvent["status"]>)) {
    event.status = value as NonNullable<SanitizedTraceEvent["status"]>;
  }
}

function normalizeAlias(value: string, prefix: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function requireContainedPath(filePath: string, directory: string, label: string): string {
  const resolved = resolve(filePath);
  const relativePath = relative(directory, resolved);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)) {
    throw new TypeError(`Provider ${label} must stay under ${directory}`);
  }
  return resolved;
}
