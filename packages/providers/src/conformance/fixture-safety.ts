import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProviderFixtureManifest, SanitizedTraceEvent } from "./types.js";
import { PROVIDER_CONFORMANCE_CONTRACT_VERSION } from "./types.js";

const PROVIDER_IDS = new Set(["claude", "codex", "copilot", "cursor"]);
const PROFILES = new Set([
  "core",
  "build",
  "plan",
  "completion",
  "goals",
  "permissions",
  "usage",
  "session-eviction",
  "clean-fork",
  "orchestration",
  "browser-access",
  "thread-control",
  "provider-continuation",
  "child-cancellation",
]);
const EVENT_KINDS = new Set(["session", "turn", "item", "terminal"]);
const EVENT_STATUSES = new Set(["started", "completed", "interrupted", "errored"]);
const FORBIDDEN_KEYS = /^(?:prompt|response|text|content|secret|token|password|environment|env|path|raw|rawOutput|toolOutput)$/i;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/(?:home|users|private|tmp|var|etc)\/)/i;
const SECRET_VALUE = /(?:bearer\s+|authorization\s*=|password\s*=|api[_-]?key\s*=|\bsk-[a-z0-9_-]{8,})/i;
const SHA256 = /^[a-f0-9]{64}$/;

/** Computes the deterministic SHA-256 recorded for sanitized fixture input. */
export function providerFixtureSourceHash(input: ProviderFixtureManifest["input"]): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** Creates a reviewed fixture manifest from structural sanitizer output. */
export function createProviderFixtureManifest(
  input: Omit<ProviderFixtureManifest, "contractVersion" | "sourceHash">,
): ProviderFixtureManifest {
  const manifest: ProviderFixtureManifest = {
    ...input,
    contractVersion: PROVIDER_CONFORMANCE_CONTRACT_VERSION,
    sourceHash: providerFixtureSourceHash(input.input),
  };
  return validateProviderFixtureManifest(manifest);
}

/** Loads and validates one committed Provider fixture manifest. */
export function loadProviderFixtureManifest(filePath: string): ProviderFixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return validateProviderFixtureManifest(parsed);
}

/** Rejects unsafe, incomplete, or stale Provider fixture manifests. */
export function validateProviderFixtureManifest(value: unknown): ProviderFixtureManifest {
  rejectForbiddenContent(value);
  const manifest = requireRecord(value, "fixture manifest");
  requireExactKeys(manifest, [
    "contractVersion",
    "providerId",
    "cliVersion",
    "protocolVersion",
    "provenance",
    "requiredProfiles",
    "scenario",
    "sourceHash",
    "redaction",
    "input",
    "expected",
  ], "fixture manifest");
  if (manifest.contractVersion !== PROVIDER_CONFORMANCE_CONTRACT_VERSION) {
    throw new TypeError("Provider fixture contractVersion is unsupported");
  }
  if (typeof manifest.providerId !== "string" || !PROVIDER_IDS.has(manifest.providerId)) {
    throw new TypeError("Provider fixture providerId is invalid");
  }
  requireBoundedString(manifest.cliVersion, "cliVersion", 128);
  requireBoundedString(manifest.protocolVersion, "protocolVersion", 128);
  if (manifest.provenance !== "captured" && manifest.provenance !== "synthetic") {
    throw new TypeError("Provider fixture provenance is invalid");
  }
  const requiredProfiles = requireStringArray(manifest.requiredProfiles, "requiredProfiles", 32);
  if (!requiredProfiles.includes("core") || requiredProfiles.some((profile) => !PROFILES.has(profile))) {
    throw new TypeError("Provider fixture requiredProfiles are invalid");
  }
  requireUnique(requiredProfiles, "Provider fixture requiredProfiles");
  requireBoundedString(manifest.scenario, "scenario", 160);
  if (typeof manifest.sourceHash !== "string" || !SHA256.test(manifest.sourceHash)) {
    throw new TypeError("Provider fixture sourceHash is invalid");
  }

  const redaction = requireRecord(manifest.redaction, "redaction");
  requireExactKeys(redaction, ["reviewed", "removedFields"], "redaction");
  if (redaction.reviewed !== true) throw new TypeError("Provider fixture requires redaction review");
  requireStringArray(redaction.removedFields, "removedFields", 64);

  const input = requireRecord(manifest.input, "input");
  requireExactKeys(input, ["events"], "input");
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 10_000) {
    throw new TypeError("Provider fixture events are invalid");
  }
  const events = input.events.map((event, index) => parseEvent(event, index));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.sequence !== index + 1) {
      throw new TypeError("Provider fixture event sequences must be contiguous and start at 1");
    }
  }

  const expected = requireRecord(manifest.expected, "expected");
  requireExactKeys(expected, ["orderedKinds", "terminal", "toolPairs"], "expected");
  const orderedKinds = requireStringArray(expected.orderedKinds, "orderedKinds", 10_000);
  if (orderedKinds.some((kind) => !EVENT_KINDS.has(kind))) {
    throw new TypeError("Provider fixture expected orderedKinds are invalid");
  }
  if (expected.terminal !== "completed" && expected.terminal !== "interrupted" && expected.terminal !== "errored") {
    throw new TypeError("Provider fixture expected terminal is invalid");
  }
  if (!Array.isArray(expected.toolPairs) || expected.toolPairs.length > 1_000) {
    throw new TypeError("Provider fixture expected toolPairs are invalid");
  }
  for (const pair of expected.toolPairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError("Provider fixture tool pair is invalid");
    pair.forEach((id) => requireBoundedString(id, "tool pair identity", 256));
  }

  const typed = manifest as unknown as ProviderFixtureManifest;
  if (providerFixtureSourceHash(typed.input) !== manifest.sourceHash) {
    throw new TypeError("Provider fixture sourceHash does not match sanitized input");
  }
  return typed;
}

function parseEvent(value: unknown, index: number): SanitizedTraceEvent {
  const event = requireRecord(value, `event ${index}`);
  requireExactKeys(event, ["kind", "sequence", "nativeId", "pairId", "size", "status"], `event ${index}`);
  if (typeof event.kind !== "string" || !EVENT_KINDS.has(event.kind)) {
    throw new TypeError(`Provider fixture event ${index} kind is invalid`);
  }
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1) {
    throw new TypeError(`Provider fixture event ${index} sequence is invalid`);
  }
  if (event.nativeId !== undefined) requireBoundedString(event.nativeId, "nativeId", 256);
  if (event.pairId !== undefined) requireBoundedString(event.pairId, "pairId", 256);
  if (event.size !== undefined && (!Number.isSafeInteger(event.size) || Number(event.size) < 0 || Number(event.size) > 100_000_000)) {
    throw new TypeError(`Provider fixture event ${index} size is invalid`);
  }
  if (event.status !== undefined && (typeof event.status !== "string" || !EVENT_STATUSES.has(event.status))) {
    throw new TypeError(`Provider fixture event ${index} status is invalid`);
  }
  return event as unknown as SanitizedTraceEvent;
}

function rejectForbiddenContent(value: unknown, key = "fixture", depth = 0): void {
  if (depth > 12) throw new TypeError("Provider fixture nesting exceeds the safety limit");
  if (typeof value === "string") {
    if (value.length > 8_192) throw new TypeError(`Provider fixture ${key} exceeds the string limit`);
    if (ABSOLUTE_PATH.test(value)) throw new TypeError(`Provider fixture ${key} contains an absolute path`);
    if (SECRET_VALUE.test(value)) throw new TypeError(`Provider fixture ${key} contains secret-shaped data`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => rejectForbiddenContent(entry, key, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(childKey)) throw new TypeError(`Provider fixture contains forbidden field: ${childKey}`);
      rejectForbiddenContent(childValue, childKey, depth + 1);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Provider fixture ${label} is invalid`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new TypeError(`Provider fixture ${label} contains unexpected field: ${unexpected}`);
}

function requireBoundedString(value: unknown, label: string, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`Provider fixture ${label} is invalid`);
  }
}

function requireStringArray(value: unknown, label: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`Provider fixture ${label} is invalid`);
  }
  value.forEach((entry) => requireBoundedString(entry, label, 256));
  return value as string[];
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contain duplicates`);
}
