import type { StoredAttachment, ThoughtSegmentRecord, ToolCall } from "@/transport";
import type { ThoughtSegment } from "@/features/conversation/narrative/types";

function looksLikeContinuation(previousText: string, nextText: string): boolean {
  const lastCharacter = previousText.trimEnd().slice(-1);
  const previousEndsSentence = /[.!?]/.test(lastCharacter);
  const firstCharacter = nextText.replace(/^\s+/, "").slice(0, 1);
  const nextStartsLowercaseOrPunctuation = firstCharacter === ""
    || /[a-z,;:)\]}-]/.test(firstCharacter);
  return !previousEndsSentence || nextStartsLowercaseOrPunctuation;
}

function shouldReopenThought(last: ThoughtSegment | undefined, text: string): boolean {
  if (!last || last.endedAt === undefined) return false;
  return last.text.length < 40 || looksLikeContinuation(last.text, text);
}

function newThoughtSegment(text: string, isExplicitNonFinal: boolean): ThoughtSegment {
  return {
    text,
    startedAt: Date.now(),
    ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
  };
}

function extendThoughtSegment(
  last: ThoughtSegment,
  text: string,
  isExplicitNonFinal: boolean,
  reopen: boolean,
): ThoughtSegment {
  const next = {
    ...last,
    text: last.text + text,
    ...(isExplicitNonFinal ? { isExplicitNonFinal: true } : {}),
  };
  if (reopen) delete (next as { endedAt?: number }).endedAt;
  return next;
}

/** Appends one streamed thought fragment while preserving turn segment boundaries. */
export function appendThoughtSegment(
  segments: ThoughtSegment[],
  text: string,
  isExplicitNonFinal: boolean,
): ThoughtSegment[] {
  if (text.length === 0) return segments;
  const last = segments.at(-1);
  const reopen = shouldReopenThought(last, text);
  if (!last || (last.endedAt !== undefined && !reopen)) {
    return [...segments, newThoughtSegment(text, isExplicitNonFinal)];
  }
  return [
    ...segments.slice(0, -1),
    extendThoughtSegment(last, text, isExplicitNonFinal, reopen),
  ];
}

/** Applies the authoritative assistant-message boundary to the open thought segment. */
export function projectAssistantMessageBoundary(
  segments: ThoughtSegment[],
  isFinalResponse: boolean,
): ThoughtSegment[] | undefined {
  const last = segments.at(-1);
  if (!last || last.endedAt !== undefined) return undefined;
  return isFinalResponse
    ? segments.slice(0, -1)
    : [...segments.slice(0, -1), { ...last, endedAt: Date.now() }];
}

/** Updates tool progress without notifying state subscribers when no call changed. */
export function projectToolProgress(
  toolCalls: ToolCall[],
  toolCallId: string,
  elapsedSeconds: number,
  lastActivityAt: number,
): ToolCall[] | undefined {
  let changed = false;
  const projected = toolCalls.map((toolCall) => {
    if (toolCall.id !== toolCallId || toolCall.isComplete) return toolCall;
    changed = true;
    return { ...toolCall, elapsedSeconds, lastActivityAt };
  });
  return changed ? projected : undefined;
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && typeof record.mimeType === "string"
    && typeof record.sizeBytes === "number";
}

/** Parses persisted assistant attachments from a provider event value. */
export function parseStoredAttachments(value: unknown): StoredAttachment[] {
  return Array.isArray(value) ? value.filter(isStoredAttachment) : [];
}

/** Maps one persisted thought row to the live narrative segment shape. */
export function persistedThoughtToSegment(record: ThoughtSegmentRecord): ThoughtSegment {
  const startedAt = Date.parse(record.started_at);
  const endedAt = record.ended_at ? Date.parse(record.ended_at) : NaN;
  return {
    text: record.text,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    endedAt: Number.isFinite(endedAt) ? endedAt : undefined,
  };
}

/** Filters final-response thoughts out of persisted narrative data. */
export function visiblePersistedThoughtSegments(
  thoughts: readonly ThoughtSegmentRecord[],
): ThoughtSegment[] {
  return thoughts
    .filter((thought) => !thought.is_final_response)
    .map(persistedThoughtToSegment);
}
