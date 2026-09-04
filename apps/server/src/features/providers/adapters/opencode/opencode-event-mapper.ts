import type { AgentEvent } from "@mcode/contracts";

/**
 * SSE envelope accepted in both wrapped and flat shapes.
 * Upstream `GET /event` yields `{ type, properties }`; some buses wrap the
 * payload as `{ type, payload: { type, properties } }`. Both carry the same
 * event name; the wrapped inner type wins when present.
 */
export type OpenCodeSseEnvelope = {
  type: string;
  payload?: { type: string; properties?: Record<string, unknown> };
  properties?: Record<string, unknown>;
};

/** How one SSE envelope was classified: canonical, lifecycle-only, bounded notice, or known noise. */
export type OpenCodeMapperDisposition = "mapped" | "state-only" | "diagnostic" | "ignored";

/** Canonical events produced for one envelope plus its classification. */
export interface OpenCodeMappedOutput {
  disposition: OpenCodeMapperDisposition;
  events: AgentEvent[];
  reason?: string;
}

interface MapperContext {
  threadId: string;
  turnExecutionId?: string;
  /** Role of the message the part belongs to, when the caller tracked it. */
  partRole?: string;
  /** Text already forwarded per message, for exactly-once streaming. */
  forwardedText?: Map<string, string>;
}

interface NormalizedEnvelope {
  type: string;
  properties: Record<string, unknown>;
}

const MAX_TEXT_BYTES = 32_768;
const MAX_DIAGNOSTIC_CHARS = 1_000;

function boundText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.length > MAX_TEXT_BYTES ? value.slice(0, MAX_TEXT_BYTES) : value;
}

function boundDiagnostic(value: string): string {
  return value.length > MAX_DIAGNOSTIC_CHARS ? value.slice(0, MAX_DIAGNOSTIC_CHARS) : value;
}

function withExecution(event: AgentEvent, ctx: MapperContext): AgentEvent {
  if (!ctx.turnExecutionId) return event;
  return { ...event, turnExecutionId: ctx.turnExecutionId } as AgentEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertiesOf(holder: Record<string, unknown>): Record<string, unknown> {
  // Modern `session.next.*` envelopes carry `data`; legacy ones carry `properties`.
  if (isRecord(holder.properties)) return holder.properties;
  if (isRecord(holder.data)) return holder.data;
  return {};
}

function innerEnvelope(outer: Record<string, unknown>): NormalizedEnvelope | null {
  if (!isRecord(outer.payload)) return null;
  const inner = outer.payload;
  if (typeof inner.type !== "string" || inner.type.length === 0) return null;
  return { type: inner.type, properties: propertiesOf(inner) };
}

/** Split an envelope into its canonical event name plus properties. */
export function normalizeOpenCodeEnvelope(input: unknown): NormalizedEnvelope | null {
  if (!isRecord(input)) return null;
  if (typeof input.type !== "string" || input.type.length === 0) return null;
  return innerEnvelope(input) ?? { type: input.type, properties: propertiesOf(input) };
}

function partOf(props: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(props.part) ? props.part : null;
}

function malformedOutput(ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "diagnostic",
    events: [withExecution({ type: "system", threadId: ctx.threadId, subtype: "opencode:malformed-envelope" } satisfies AgentEvent, ctx)],
    reason: "malformed-envelope",
  };
}

function unknownEventOutput(type: string, ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "diagnostic",
    events: [withExecution({ type: "system", threadId: ctx.threadId, subtype: `opencode:unknown-event:${boundDiagnostic(type)}` } satisfies AgentEvent, ctx)],
    reason: "unknown-event-type",
  };
}

function mapSessionIdle(ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "turnComplete", threadId: ctx.threadId, reason: "end_turn",
      costUsd: null, tokensIn: 0, tokensOut: 0,
    } satisfies AgentEvent, ctx)],
  };
}

function mapSessionError(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const err = properties.error;
  const message = isRecord(err)
    ? boundDiagnostic(JSON.stringify(err).slice(0, MAX_DIAGNOSTIC_CHARS))
    : "OpenCode session error";
  return {
    disposition: "mapped",
    events: [withExecution({ type: "error", threadId: ctx.threadId, error: message } satisfies AgentEvent, ctx)],
  };
}

function mapTextPart(part: Record<string, unknown>, properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const key = typeof part.messageID === "string" && part.messageID.length > 0
    ? part.messageID
    : typeof part.id === "string" ? part.id : "";
  if (typeof properties.delta === "string") {
    return emitTextRemainder(ctx, key, properties.delta, true);
  }
  const text = typeof part.text === "string" ? part.text : "";
  if (!text) return { disposition: "state-only", events: [] };
  return emitTextRemainder(ctx, key, text, false);
}

function emitTextRemainder(ctx: MapperContext, key: string, text: string, isDelta: boolean): OpenCodeMappedOutput {
  const remainder = partTextRemainder(ctx.forwardedText, key, boundText(text), isDelta);
  if (!remainder) return { disposition: "state-only", events: [] };
  return {
    disposition: "mapped",
    events: [withExecution({ type: "textDelta", threadId: ctx.threadId, delta: remainder } satisfies AgentEvent, ctx)],
  };
}

function toolCallIdOf(part: Record<string, unknown>): string {
  if (typeof part.callID === "string" && part.callID.length > 0) return part.callID;
  return typeof part.id === "string" ? part.id : "tool-unknown";
}

function toolInputOf(state: Record<string, unknown> | undefined): Record<string, unknown> {
  return isRecord(state?.input) ? state.input : {};
}

function mapToolRunning(toolCallId: string, toolName: string, state: Record<string, unknown> | undefined, ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "toolUse", threadId: ctx.threadId, toolCallId, toolName, toolInput: toolInputOf(state),
    } satisfies AgentEvent, ctx)],
  };
}

function mapToolCompleted(toolCallId: string, state: Record<string, unknown> | undefined, ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "toolResult", threadId: ctx.threadId, toolCallId, output: boundText(state?.output), isError: false,
    } satisfies AgentEvent, ctx)],
  };
}

function mapToolFailed(toolCallId: string, state: Record<string, unknown> | undefined, ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "toolResult", threadId: ctx.threadId, toolCallId,
      output: boundText(typeof state?.error === "string" ? state.error : "Tool failed"), isError: true,
    } satisfies AgentEvent, ctx)],
  };
}

function mapToolPart(part: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const state = isRecord(part.state) ? part.state : undefined;
  const status = typeof state?.status === "string" ? state.status : "pending";
  const toolCallId = toolCallIdOf(part);
  const toolName = typeof part.tool === "string" ? part.tool : "unknown";
  if (status === "completed") return mapToolCompleted(toolCallId, state, ctx);
  if (status !== "pending" && status !== "running") return mapToolFailed(toolCallId, state, ctx);
  return mapToolRunning(toolCallId, toolName, state, ctx);
}

function mapStepFinishPart(part: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {  const tokens = isRecord(part.tokens) ? part.tokens : {};
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "turnComplete", threadId: ctx.threadId, reason: typeof part.reason === "string" ? part.reason : "end_turn",
      costUsd: typeof part.cost === "number" ? part.cost : null,
      tokensIn: typeof tokens.input === "number" ? tokens.input : 0,
      tokensOut: typeof tokens.output === "number" ? tokens.output : 0,
    } satisfies AgentEvent, ctx)],
  };
}

const STATE_ONLY_PART_TYPES = new Set([
  "step-start", "snapshot", "patch", "agent", "retry", "compaction", "subtask", "file",
]);

/** Largest retained per-message text map before pruning oldest. */
const MAX_TRACKED_PART_TEXT = 128;

function rememberBounded(map: Map<string, string>, key: string, value: string, max: number): void {
  map.set(key, value);
  if (map.size <= max) return;
  const oldest = map.keys().next().value as string | undefined;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * Exactly-once slice of new part text. Upstream streams each slice as a
 * standalone delta and then repeats the full text in a part snapshot; without
 * this, every reply renders two to three times.
 */
function partTextRemainder(
  forwarded: Map<string, string> | undefined,
  key: string,
  text: string,
  isDelta: boolean,
): string {
  if (!text || !key || !forwarded) return text;
  const prev = forwarded.get(key) ?? "";
  if (text === prev) return "";
  if (isDelta) {
    if (prev.endsWith(text)) return "";
    rememberBounded(forwarded, key, prev + text, MAX_TRACKED_PART_TEXT);
    return text;
  }
  if (text.startsWith(prev)) {
    const rest = text.slice(prev.length);
    rememberBounded(forwarded, key, text, MAX_TRACKED_PART_TEXT);
    return rest;
  }
  if (prev.startsWith(text)) return "";
  rememberBounded(forwarded, key, text, MAX_TRACKED_PART_TEXT);
  return text;
}

/** Join text fields out of a tool content array; upstream sends parts, not a string. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string" && item.text.length > 0) texts.push(item.text);
  }
  return boundText(texts.join("\n"));
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function mapNextTextDelta(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const delta = typeof properties.delta === "string" ? properties.delta : "";
  if (!delta) return { disposition: "state-only", events: [] };
  return {
    disposition: "mapped",
    events: [withExecution({ type: "textDelta", threadId: ctx.threadId, delta: boundText(delta) } satisfies AgentEvent, ctx)],
  };
}

function mapNextToolCalled(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const toolCallId = typeof properties.callID === "string" && properties.callID.length > 0 ? properties.callID : "tool-unknown";
  const toolName = typeof properties.tool === "string" ? properties.tool : "unknown";
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "toolUse", threadId: ctx.threadId, toolCallId, toolName,
      toolInput: isRecord(properties.input) ? properties.input : {},
    } satisfies AgentEvent, ctx)],
  };
}

function mapNextToolSuccess(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const toolCallId = typeof properties.callID === "string" && properties.callID.length > 0 ? properties.callID : "tool-unknown";
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "toolResult", threadId: ctx.threadId, toolCallId,
      output: toolContentText(properties.content), isError: false,
    } satisfies AgentEvent, ctx)],
  };
}

function mapNextToolFailed(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const toolCallId = typeof properties.callID === "string" && properties.callID.length > 0 ? properties.callID : "tool-unknown";
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "toolResult", threadId: ctx.threadId, toolCallId,
      output: boundText(typeof properties.error === "string" ? properties.error : "Tool failed"), isError: true,
    } satisfies AgentEvent, ctx)],
  };
}

function mapNextStepEnded(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const tokens = isRecord(properties.tokens) ? properties.tokens : {};
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "turnComplete", threadId: ctx.threadId,
      reason: typeof properties.finish === "string" ? properties.finish : "end_turn",
      costUsd: typeof properties.cost === "number" ? properties.cost : null,
      tokensIn: numberOrZero(tokens.input),
      tokensOut: numberOrZero(tokens.output),
    } satisfies AgentEvent, ctx)],
  };
}

function mapNextStepFailed(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  return {
    disposition: "mapped",
    events: [withExecution({
      type: "error", threadId: ctx.threadId,
      error: boundDiagnostic(typeof properties.error === "string" ? properties.error : "OpenCode step failed"),
    } satisfies AgentEvent, ctx)],
  };
}

function mapPermissionAsked(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const permission = typeof properties.permission === "string" ? properties.permission : "unknown";
  return {
    disposition: "diagnostic",
    events: [withExecution({
      type: "system", threadId: ctx.threadId,
      subtype: `opencode:permission-asked:${boundDiagnostic(permission)}`,
    } satisfies AgentEvent, ctx)],
    reason: "permission-asked",
  };
}

function mapPartByType(part: Record<string, unknown>, properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  const partType = part.type;
  if (partType === "text") return mapTextPart(part, properties, ctx);
  if (partType === "reasoning") return { disposition: "ignored", events: [], reason: "reasoning-not-surfaced" };
  if (partType === "tool") return mapToolPart(part, ctx);
  if (partType === "step-finish") return mapStepFinishPart(part, ctx);
  if (typeof partType === "string" && STATE_ONLY_PART_TYPES.has(partType)) return { disposition: "state-only", events: [] };
  return {
    disposition: "diagnostic",
    events: [withExecution({ type: "system", threadId: ctx.threadId, subtype: `opencode:unknown-part:${boundDiagnostic(String(partType))}` } satisfies AgentEvent, ctx)],
    reason: "unknown-part-type",
  };
}

/**
 * Streaming text for one part. Upstream sends these as standalone
 * `message.part.delta` events carrying only the new slice (`field: "text"`),
 * distinct from `message.part.updated` snapshots.
 */
function mapPartDelta(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  if (ctx.partRole === "user") return { disposition: "state-only", events: [] };
  if (typeof properties.field === "string" && properties.field !== "text") {
    return { disposition: "state-only", events: [] };
  }
  const delta = typeof properties.delta === "string" ? properties.delta : "";
  if (!delta) return { disposition: "state-only", events: [] };
  const key = typeof properties.messageID === "string" && properties.messageID.length > 0
    ? properties.messageID
    : typeof properties.partID === "string" ? properties.partID : "";
  return emitTextRemainder(ctx, key, delta, true);
}

function mapMessagePartUpdated(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {  const part = partOf(properties);
  if (!part) {
    return {
      disposition: "diagnostic",
      events: [withExecution({ type: "system", threadId: ctx.threadId, subtype: "opencode:part-without-body" } satisfies AgentEvent, ctx)],
      reason: "part-without-body",
    };
  }
  // User message parts share the session SSE feed. They must never become
  // assistant deltas otherwise every reply echoes the prompt.
  if (ctx.partRole === "user") return { disposition: "state-only", events: [] };
  return mapPartByType(part, properties, ctx);
}

function mapMessageUpdated(properties: Record<string, unknown>, ctx: MapperContext): OpenCodeMappedOutput {
  void ctx;
  const info = properties.info;
  if (!isRecord(info) || info.role !== "assistant") return { disposition: "state-only", events: [] };
  return { disposition: "state-only", events: [] };
}

const STATE_ONLY_EVENT_TYPES = new Set([
  "server.connected",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.compacted",
  "session.status",
  "message.removed",
  "message.part.removed",
  "permission.updated",
  "permission.replied",
]);

type NormalizedHandler = (properties: Record<string, unknown>, ctx: MapperContext) => OpenCodeMappedOutput;

const EXACT_HANDLERS: Readonly<Record<string, NormalizedHandler>> = {
  "session.idle": (_properties, ctx) => mapSessionIdle(ctx),
  "session.error": (properties, ctx) => mapSessionError(properties, ctx),
  "message.updated": (properties, ctx) => mapMessageUpdated(properties, ctx),
  "message.part.updated": (properties, ctx) => mapMessagePartUpdated(properties, ctx),
  "message.part.delta": (properties, ctx) => mapPartDelta(properties, ctx),
  "session.next.text.delta": (properties, ctx) => mapNextTextDelta(properties, ctx),
  "session.next.tool.called": (properties, ctx) => mapNextToolCalled(properties, ctx),
  "session.next.tool.success": (properties, ctx) => mapNextToolSuccess(properties, ctx),
  "session.next.tool.failed": (properties, ctx) => mapNextToolFailed(properties, ctx),
  "session.next.step.ended": (properties, ctx) => mapNextStepEnded(properties, ctx),
  "session.next.step.failed": (properties, ctx) => mapNextStepFailed(properties, ctx),
  "permission.asked": (properties, ctx) => mapPermissionAsked(properties, ctx),
  "permission.v2.asked": (properties, ctx) => mapPermissionAsked(properties, ctx),
};

const NEXT_STATE_ONLY_TYPES = new Set([
  "session.next.text.started",
  "session.next.text.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.progress",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.step.started",
  "session.next.model.switched",
  "session.next.context.updated",
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.moved",
  "session.next.synthetic",
  "session.next.agent.switched",
  "session.next.revert.staged",
  "session.next.revert.committed",
  "session.next.revert.cleared",
  "session.next.retried",
  "session.next.compaction.delta",
  "permission.replied",
  "permission.v2.replied",
]);

const NEXT_IGNORED_TYPES = new Set([
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
]);

const NEXT_COMPACTING_TYPES = new Set([
  "session.next.compaction.started",
  "session.next.compaction.ended",
]);

const NOISE_PREFIXES = ["todo.", "pty.", "tui.", "lsp.", "installation.", "server.", "plugin."] as const;

const NOISE_EXACT_TYPES = new Set([
  "file.edited",
  "file.watcher.updated",
  "command.executed",
  "session.diff",
  "vcs.branch.updated",
  "catalog.updated",
  "reference.updated",
  "integration.updated",
]);

function isNoiseType(type: string): boolean {
  if (NOISE_EXACT_TYPES.has(type)) return true;
  return NOISE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function mapNormalized(normalized: NormalizedEnvelope, ctx: MapperContext): OpenCodeMappedOutput {
  const { type, properties } = normalized;
  if (STATE_ONLY_EVENT_TYPES.has(type) || NEXT_STATE_ONLY_TYPES.has(type)) {
    return { disposition: "state-only", events: [] };
  }
  if (NEXT_IGNORED_TYPES.has(type)) return { disposition: "ignored", events: [], reason: "reasoning-not-surfaced" };
  if (NEXT_COMPACTING_TYPES.has(type)) {
    return {
      disposition: "mapped",
      events: [withExecution({
        type: "compacting", threadId: ctx.threadId, active: type.endsWith(".started"),
      } satisfies AgentEvent, ctx)],
    };
  }
  const exact = EXACT_HANDLERS[type];
  if (exact) return exact(properties, ctx);
  if (isNoiseType(type)) return { disposition: "ignored", events: [], reason: `noise:${type}` };
  return unknownEventOutput(type, ctx);
}

/**
 * Pure exhaustive mapper from OpenCode SSE events to canonical AgentEvents.
 * Raw upstream payload never leaves this module; unknown valid notices become
 * bounded diagnostics, lifecycle-only signals become state-only, and known
 * noise becomes ignored-with-reason.
 */
export function mapOpenCodeEnvelope(input: unknown, ctx: MapperContext): OpenCodeMappedOutput {
  const normalized = normalizeOpenCodeEnvelope(input);
  if (!normalized) return malformedOutput(ctx);
  return mapNormalized(normalized, ctx);
}
