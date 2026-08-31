import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type {
  CursorAcpTraceEnvelope,
  CursorAcpTraceExpectedSemantics,
  CursorAcpTraceFixture,
  ProviderFixtureManifest,
  SanitizedTraceEvent,
} from "./types.js";
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
const CURSOR_ACP_UPDATE_TYPES = new Set(["tool_call", "tool_call_update", "session_info_update"]);
const CURSOR_ACP_TOOL_KINDS = new Set(["read", "other"]);
const CURSOR_ACP_TOOL_CALL_STATUSES = new Set(["pending", "in_progress"]);
const CURSOR_ACP_TOOL_UPDATE_STATUSES = new Set(["in_progress", "completed", "failed"]);
const CURSOR_ACP_EXT_METHODS = new Set(["cursor/task", "cursor/create_plan", "cursor/continue"]);
const CURSOR_ACP_EVENT_TYPES = new Set(["toolUse", "toolResult"]);
const CURSOR_ACP_TOOL_NAMES = new Set(["Read", "Agent"]);
const CURSOR_ACP_UNSUPPORTED_METHODS = new Set(["cursor/task", "cursor/continue"]);
const FORBIDDEN_KEYS = /^(?:prompt|response|text|content|secret|token|password|environment|env|path|raw|rawOutput|toolOutput)$/i;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/(?:home|users|private|tmp|var|etc)\/)/i;
const SECRET_VALUE = /(?:bearer\s+|authorization\s*=|password\s*=|api[_-]?key\s*=|\bsk-[a-z0-9_-]{8,})/i;
const SHA256 = /^[a-f0-9]{64}$/;

/** Computes the deterministic SHA-256 recorded for sanitized fixture input. */
export function providerFixtureSourceHash(input: ProviderFixtureManifest["input"]): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(input)).digest("hex");
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
  const parsed: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
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
  const isCursor = validateManifestMetadata(manifest);
  validateManifestRedaction(manifest.redaction);
  validateManifestInput(manifest.input, isCursor);
  validateManifestExpected(manifest.expected);

  const typed = manifest as unknown as ProviderFixtureManifest;
  if (providerFixtureSourceHash(typed.input) !== manifest.sourceHash) {
    throw new TypeError("Provider fixture sourceHash does not match sanitized input");
  }
  return typed;
}

function validateManifestMetadata(manifest: Record<string, unknown>): boolean {
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
  return manifest.providerId === "cursor";
}

function validateManifestRedaction(value: unknown): void {
  const redaction = requireRecord(value, "redaction");
  requireExactKeys(redaction, ["reviewed", "removedFields"], "redaction");
  if (redaction.reviewed !== true) throw new TypeError("Provider fixture requires redaction review");
  requireStringArray(redaction.removedFields, "removedFields", 64);
}

function validateManifestInput(value: unknown, isCursor: boolean): void {
  const input = requireRecord(value, "input");
  requireExactKeys(input, isCursor ? ["events", "cursorAcpTrace"] : ["events"], "input");
  if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 10_000) {
    throw new TypeError("Provider fixture events are invalid");
  }
  const events = input.events.map((event, index) => parseEvent(event, index));
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.sequence !== index + 1) {
      throw new TypeError("Provider fixture event sequences must be contiguous and start at 1");
    }
  }
  if (isCursor) parseCursorAcpTrace(input.cursorAcpTrace);
}

function validateManifestExpected(value: unknown): void {
  const expected = requireRecord(value, "expected");
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
}

function parseEvent(value: unknown, index: number): SanitizedTraceEvent {
  const event = requireRecord(value, `event ${index}`);
  requireExactKeys(event, ["kind", "sequence", "nativeId", "pairId", "size", "status"], `event ${index}`);
  validateEventKind(event.kind, index);
  validateEventSequence(event.sequence, index);
  validateOptionalEventIdentifier(event.nativeId, "nativeId");
  validateOptionalEventIdentifier(event.pairId, "pairId");
  validateEventSize(event.size, index);
  validateEventStatus(event.status, index);
  return event as unknown as SanitizedTraceEvent;
}

function validateEventKind(value: unknown, index: number): void {
  if (typeof value !== "string" || !EVENT_KINDS.has(value)) {
    throw new TypeError(`Provider fixture event ${index} kind is invalid`);
  }
}

function validateEventSequence(value: unknown, index: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`Provider fixture event ${index} sequence is invalid`);
  }
}

function validateOptionalEventIdentifier(value: unknown, label: string): void {
  if (value !== undefined) requireBoundedString(value, label, 256);
}

function validateEventSize(value: unknown, index: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100_000_000) {
    throw new TypeError(`Provider fixture event ${index} size is invalid`);
  }
}

function validateEventStatus(value: unknown, index: number): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !EVENT_STATUSES.has(value)) {
    throw new TypeError(`Provider fixture event ${index} status is invalid`);
  }
}

function parseCursorAcpTrace(value: unknown): CursorAcpTraceFixture {
  const trace = requireRecord(value, "Cursor ACP trace");
  requireExactKeys(trace, ["envelopes", "expected"], "Cursor ACP trace");

  if (!Array.isArray(trace.envelopes) || trace.envelopes.length === 0 || trace.envelopes.length > 1_000) {
    throw new TypeError("Cursor ACP trace envelopes are invalid");
  }
  const envelopes = trace.envelopes.map((envelope, index) => parseCursorAcpEnvelope(envelope, index));
  for (let index = 0; index < envelopes.length; index += 1) {
    if (envelopes[index]!.sequence !== index + 1) {
      throw new TypeError("Cursor ACP trace envelope sequences must be contiguous and start at 1");
    }
  }

  return {
    envelopes,
    expected: parseCursorAcpExpected(trace.expected),
  };
}

function parseCursorAcpEnvelope(value: unknown, index: number): CursorAcpTraceEnvelope {
  const envelope = requireRecord(value, `Cursor ACP trace envelope ${index}`);
  if (typeof envelope.kind !== "string") {
    throw new TypeError(`Cursor ACP trace envelope ${index} kind is invalid`);
  }
  if (!Number.isSafeInteger(envelope.sequence) || Number(envelope.sequence) < 1) {
    throw new TypeError(`Cursor ACP trace envelope ${index} sequence is invalid`);
  }
  switch (envelope.kind) {
    case "session/update":
      requireExactKeys(envelope, ["sequence", "kind", "sessionId", "update"], `Cursor ACP trace envelope ${index}`);
      requireBoundedString(envelope.sessionId, "Cursor ACP trace sessionId", 256);
      return {
        sequence: envelope.sequence,
        kind: "session/update",
        sessionId: envelope.sessionId,
        update: parseCursorAcpSessionUpdate(envelope.update),
      } as CursorAcpTraceEnvelope;
    case "ext-method":
      requireExactKeys(envelope, ["sequence", "kind", "method", "params"], `Cursor ACP trace envelope ${index}`);
      return parseCursorAcpExtMethodEnvelope(envelope, index);
    case "request-permission":
      requireExactKeys(envelope, ["sequence", "kind", "request"], `Cursor ACP trace envelope ${index}`);
      return {
        sequence: envelope.sequence,
        kind: "request-permission",
        request: parseCursorAcpPermissionRequest(envelope.request),
      } as CursorAcpTraceEnvelope;
    default:
      throw new TypeError(`Cursor ACP trace envelope ${index} kind is invalid`);
  }
}

function parseCursorAcpSessionUpdate(
  value: unknown,
): Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"] {
  const update = requireRecord(value, "Cursor ACP session/update");
  if (typeof update.sessionUpdate !== "string" || !CURSOR_ACP_UPDATE_TYPES.has(update.sessionUpdate)) {
    throw new TypeError("Cursor ACP session/update type is invalid");
  }
  switch (update.sessionUpdate) {
    case "tool_call":
      return parseCursorAcpToolCall(update);
    case "tool_call_update":
      return parseCursorAcpToolCallUpdate(update);
    case "session_info_update":
      return parseCursorAcpSessionInfoUpdate(update);
  }
  throw new TypeError("Cursor ACP session/update type is invalid");
}

function parseCursorAcpToolCall(
  update: Record<string, unknown>,
): Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"] {
  requireExactKeys(update, ["sessionUpdate", "toolCallId", "title", "kind", "status"], "Cursor ACP tool_call");
  requireBoundedString(update.toolCallId, "Cursor ACP toolCallId", 256);
  requireBoundedString(update.title, "Cursor ACP tool title", 256);
  if (typeof update.kind !== "string" || !CURSOR_ACP_TOOL_KINDS.has(update.kind)) {
    throw new TypeError("Cursor ACP tool kind is invalid");
  }
  if (typeof update.status !== "string" || !CURSOR_ACP_TOOL_CALL_STATUSES.has(update.status)) {
    throw new TypeError("Cursor ACP tool status is invalid");
  }
  return update as Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"];
}

function parseCursorAcpToolCallUpdate(
  update: Record<string, unknown>,
): Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"] {
  requireExactKeys(update, ["sessionUpdate", "toolCallId", "status"], "Cursor ACP tool_call_update");
  requireBoundedString(update.toolCallId, "Cursor ACP toolCallId", 256);
  if (typeof update.status !== "string" || !CURSOR_ACP_TOOL_UPDATE_STATUSES.has(update.status)) {
    throw new TypeError("Cursor ACP tool update status is invalid");
  }
  return update as Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"];
}

function parseCursorAcpSessionInfoUpdate(
  update: Record<string, unknown>,
): Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"] {
  requireExactKeys(update, ["sessionUpdate"], "Cursor ACP session_info_update");
  return update as Extract<CursorAcpTraceEnvelope, { kind: "session/update" }>["update"];
}

function parseCursorAcpExtMethodEnvelope(
  envelope: Record<string, unknown>,
  index: number,
): CursorAcpTraceEnvelope {
  if (typeof envelope.method !== "string" || !CURSOR_ACP_EXT_METHODS.has(envelope.method)) {
    throw new TypeError(`Cursor ACP trace envelope ${index} method is invalid`);
  }
  switch (envelope.method) {
    case "cursor/task": {
      if (envelope.params === null) {
        return { sequence: envelope.sequence as number, kind: "ext-method", method: envelope.method, params: null };
      }
      const params = requireRecord(envelope.params, "Cursor ACP task params");
      requireExactKeys(params, ["toolCallId"], "Cursor ACP task params");
      requireBoundedString(params.toolCallId, "Cursor ACP task toolCallId", 256);
      return {
        sequence: envelope.sequence as number,
        kind: "ext-method",
        method: envelope.method,
        params: { toolCallId: params.toolCallId },
      };
    }
    case "cursor/create_plan": {
      const params = requireRecord(envelope.params, "Cursor ACP create_plan params");
      requireExactKeys(params, ["markdown"], "Cursor ACP create_plan params");
      requireBoundedString(params.markdown, "Cursor ACP plan markdown", 1_000);
      return {
        sequence: envelope.sequence as number,
        kind: "ext-method",
        method: envelope.method,
        params: { markdown: params.markdown },
      };
    }
    case "cursor/continue": {
      const params = requireRecord(envelope.params, "Cursor ACP continuation params");
      requireExactKeys(params, [], "Cursor ACP continuation params");
      return { sequence: envelope.sequence as number, kind: "ext-method", method: envelope.method, params: {} };
    }
  }
  throw new TypeError(`Cursor ACP trace envelope ${index} method is invalid`);
}

function parseCursorAcpPermissionRequest(
  value: unknown,
): Extract<CursorAcpTraceEnvelope, { kind: "request-permission" }>["request"] {
  const request = requireRecord(value, "Cursor ACP permission request");
  requireExactKeys(request, ["sessionId", "options", "toolCall"], "Cursor ACP permission request");
  requireBoundedString(request.sessionId, "Cursor ACP permission sessionId", 256);
  if (!Array.isArray(request.options) || request.options.length !== 1) {
    throw new TypeError("Cursor ACP permission options are invalid");
  }
  const option = requireRecord(request.options[0], "Cursor ACP permission option");
  requireExactKeys(option, ["optionId", "kind", "name"], "Cursor ACP permission option");
  requireBoundedString(option.optionId, "Cursor ACP permission optionId", 256);
  requireBoundedString(option.name, "Cursor ACP permission name", 256);
  if (option.kind !== "allow_once") throw new TypeError("Cursor ACP permission option kind is invalid");
  const toolCall = requireRecord(request.toolCall, "Cursor ACP permission toolCall");
  requireExactKeys(toolCall, ["title"], "Cursor ACP permission toolCall");
  requireBoundedString(toolCall.title, "Cursor ACP permission tool title", 256);
  return {
    sessionId: request.sessionId,
    options: [{ optionId: option.optionId, kind: "allow_once", name: option.name }],
    toolCall: { title: toolCall.title },
  };
}

function parseCursorAcpExpected(value: unknown): CursorAcpTraceExpectedSemantics {
  const expected = requireRecord(value, "Cursor ACP trace expected semantics");
  requireExactKeys(expected, [
    "emittedEventTypes",
    "toolNames",
    "planExitCount",
    "permissionOutcomes",
    "unsupportedMethods",
    "ignoredForeignSessionUpdateCount",
  ], "Cursor ACP trace expected semantics");
  const emittedEventTypes = requireStringArray(expected.emittedEventTypes, "Cursor ACP trace emittedEventTypes", 1_000);
  if (emittedEventTypes.some((type) => !CURSOR_ACP_EVENT_TYPES.has(type))) {
    throw new TypeError("Cursor ACP trace emittedEventTypes are invalid");
  }
  const toolNames = requireStringArray(expected.toolNames, "Cursor ACP trace toolNames", 1_000);
  if (toolNames.some((toolName) => !CURSOR_ACP_TOOL_NAMES.has(toolName))) {
    throw new TypeError("Cursor ACP trace toolNames are invalid");
  }
  if (!Number.isSafeInteger(expected.planExitCount) || Number(expected.planExitCount) < 0) {
    throw new TypeError("Cursor ACP trace planExitCount is invalid");
  }
  const permissionOutcomes = requireStringArrayOrEmpty(
    expected.permissionOutcomes,
    "Cursor ACP trace permissionOutcomes",
    64,
  );
  if (permissionOutcomes.some((outcome) => outcome !== "selected")) {
    throw new TypeError("Cursor ACP trace permissionOutcomes are invalid");
  }
  const unsupportedMethods = requireStringArrayOrEmpty(
    expected.unsupportedMethods,
    "Cursor ACP trace unsupportedMethods",
    64,
  );
  if (unsupportedMethods.some((method) => !CURSOR_ACP_UNSUPPORTED_METHODS.has(method))) {
    throw new TypeError("Cursor ACP trace unsupportedMethods are invalid");
  }
  if (
    !Number.isSafeInteger(expected.ignoredForeignSessionUpdateCount)
    || Number(expected.ignoredForeignSessionUpdateCount) < 0
  ) {
    throw new TypeError("Cursor ACP trace ignoredForeignSessionUpdateCount is invalid");
  }
  return {
    emittedEventTypes: emittedEventTypes as CursorAcpTraceExpectedSemantics["emittedEventTypes"],
    toolNames: toolNames as CursorAcpTraceExpectedSemantics["toolNames"],
    planExitCount: Number(expected.planExitCount),
    permissionOutcomes: permissionOutcomes as CursorAcpTraceExpectedSemantics["permissionOutcomes"],
    unsupportedMethods: unsupportedMethods as CursorAcpTraceExpectedSemantics["unsupportedMethods"],
    ignoredForeignSessionUpdateCount: Number(expected.ignoredForeignSessionUpdateCount),
  };
}

function rejectForbiddenContent(value: unknown, key = "fixture", depth = 0): void {
  if (depth > 12) throw new TypeError("Provider fixture nesting exceeds the safety limit");
  if (typeof value === "string") {
    rejectForbiddenString(value, key);
    return;
  }
  if (Array.isArray(value)) {
    rejectForbiddenArray(value, key, depth);
    return;
  }
  if (value && typeof value === "object") {
    rejectForbiddenRecord(value, depth);
  }
}

function rejectForbiddenString(value: string, key: string): void {
  if (value.length > 8_192) throw new TypeError(`Provider fixture ${key} exceeds the string limit`);
  if (ABSOLUTE_PATH.test(value)) throw new TypeError(`Provider fixture ${key} contains an absolute path`);
  if (SECRET_VALUE.test(value)) throw new TypeError(`Provider fixture ${key} contains secret-shaped data`);
}

function rejectForbiddenArray(value: readonly unknown[], key: string, depth: number): void {
  value.forEach((entry) => rejectForbiddenContent(entry, key, depth + 1));
}

function rejectForbiddenRecord(value: object, depth: number): void {
  for (const [childKey, childValue] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(childKey)) throw new TypeError(`Provider fixture contains forbidden field: ${childKey}`);
    rejectForbiddenContent(childValue, childKey, depth + 1);
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

function requireStringArrayOrEmpty(value: unknown, label: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new TypeError(`Provider fixture ${label} is invalid`);
  }
  value.forEach((entry) => requireBoundedString(entry, label, 256));
  return value as string[];
}
