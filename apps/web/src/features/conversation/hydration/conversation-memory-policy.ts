import type { Message } from "@/transport";

/** Message bytes retained for the visible conversation window. */
export const ACTIVE_CONVERSATION_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Total active conversation bytes, including narrative and keyed metadata. */
export const ACTIVE_CONVERSATION_BYTES = 13 * 1024 * 1024;

/** Message bytes retained for the visible conversation during critical pressure. */
export const CRITICAL_ACTIVE_CONVERSATION_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Total bytes retained for inactive conversation records. */
export const INACTIVE_CONVERSATION_BYTES = 16 * 1024 * 1024;

/** Total bytes retained for speculative history pages. */
export const PREFETCHED_CONVERSATION_BYTES = 4 * 1024 * 1024;

/** Total narrative bytes retained across conversation caches. */
export const CONVERSATION_NARRATIVE_BYTES = 4 * 1024 * 1024;

const encoder = new TextEncoder();

/** Return the encoded JSON size of a retained conversation value. */
export function measureConversationValue(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : encoder.encode(serialized).byteLength;
}

/** Return the encoded bytes retained by message rows. */
export function measureConversationMessages(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + measureConversationValue(message), 0);
}

/** Result of fitting one contiguous conversation window to a byte budget. */
export interface SelectedConversationWindow {
  messages: Message[];
  evictedOlder: boolean;
  evictedNewer: boolean;
}

interface ConversationWindowBounds {
  start: number;
  end: number;
  bytes: number;
  count: number;
}

function initialWindowBounds(messages: readonly Message[], sizes: readonly number[], options: { anchorMessageId?: string; preference: "older" | "newer" }): ConversationWindowBounds {
  const anchorIndex = options.anchorMessageId ? messages.findIndex((message) => message.id === options.anchorMessageId) : -1;
  const start = anchorIndex >= 0 ? anchorIndex : options.preference === "older" ? 0 : messages.length - 1;
  return { start, end: start, bytes: sizes[start] ?? 0, count: 1 };
}

function addWindowMessage(bounds: ConversationWindowBounds, sizes: readonly number[], index: number, side: "older" | "newer", maxBytes: number, maxMessages: number): boolean {
  if (index < 0 || index >= sizes.length || bounds.count >= maxMessages) return false;
  const nextBytes = bounds.bytes + (sizes[index] ?? 0);
  if (nextBytes > maxBytes) return false;
  bounds.bytes = nextBytes;
  bounds.count += 1;
  if (side === "older") bounds.start = index;
  else bounds.end = index;
  return true;
}

function fillWindowSide(bounds: ConversationWindowBounds, sizes: readonly number[], side: "older" | "newer", maxBytes: number, maxMessages: number): void {
  const nextIndex = () => side === "older" ? bounds.start - 1 : bounds.end + 1;
  while (addWindowMessage(bounds, sizes, nextIndex(), side, maxBytes, maxMessages)) {
    // A contiguous window cannot skip an over-budget row.
  }
}

function windowFillOrder(messages: readonly Message[], options: { anchorMessageId?: string; preference: "older" | "newer" }): readonly ("older" | "newer")[] {
  const hasAnchor = options.anchorMessageId !== undefined && messages.some((message) => message.id === options.anchorMessageId);
  if (!hasAnchor) return options.preference === "older" ? ["newer"] : ["older"];
  return options.preference === "older" ? ["older", "newer"] : ["newer", "older"];
}

/** Keep narrative batches for the most valuable resident messages within a byte budget. */
export function selectConversationNarrative<T>(
  narrativeByMessage: Record<string, T | undefined>,
  messages: readonly Message[],
  options: { anchorMessageId?: string; maxBytes: number },
): Record<string, T | undefined> {
  const messageIds = messages.map((message) => message.id);
  const anchorIndex = options.anchorMessageId
    ? messageIds.indexOf(options.anchorMessageId)
    : -1;
  const orderedIds = anchorIndex >= 0
    ? [
        messageIds[anchorIndex],
        ...messageIds.slice(0, anchorIndex).reverse(),
        ...messageIds.slice(anchorIndex + 1),
      ]
    : [...messageIds].reverse();
  const retained: Record<string, T | undefined> = {};
  let retainedBytes = 0;
  for (const messageId of orderedIds) {
    if (!messageId) continue;
    const narrative = narrativeByMessage[messageId];
    if (!narrative) continue;
    const bytes = measureConversationValue(narrative);
    if (retainedBytes + bytes > options.maxBytes) continue;
    retained[messageId] = narrative;
    retainedBytes += bytes;
  }
  return retained;
}

/**
 * Select a contiguous byte-bounded window and retain the visible anchor when present.
 * One oversized anchor remains resident because viewport stability takes precedence.
 */
export function selectConversationWindow(
  messages: readonly Message[],
  options: {
    anchorMessageId?: string;
    maxBytes: number;
    maxMessages: number;
    preference: "older" | "newer";
  },
): SelectedConversationWindow {
  if (messages.length === 0) {
    return { messages: [], evictedOlder: false, evictedNewer: false };
  }
  const sizes = messages.map(measureConversationValue);
  const bounds = initialWindowBounds(messages, sizes, options);
  for (const side of windowFillOrder(messages, options)) {
    fillWindowSide(bounds, sizes, side, options.maxBytes, options.maxMessages);
  }

  return {
    messages: messages.slice(bounds.start, bounds.end + 1),
    evictedOlder: bounds.start > 0,
    evictedNewer: bounds.end < messages.length - 1,
  };
}
