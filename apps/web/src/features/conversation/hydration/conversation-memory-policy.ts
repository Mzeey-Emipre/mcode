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
  const anchorIndex = options.anchorMessageId
    ? messages.findIndex((message) => message.id === options.anchorMessageId)
    : -1;
  let start = anchorIndex >= 0
    ? anchorIndex
    : options.preference === "older" ? 0 : messages.length - 1;
  let end = start;
  let bytes = sizes[start] ?? 0;
  let count = 1;

  const tryInclude = (index: number, side: "older" | "newer"): boolean => {
    if (index < 0 || index >= messages.length || count >= options.maxMessages) return false;
    const nextBytes = bytes + (sizes[index] ?? 0);
    if (nextBytes > options.maxBytes) return false;
    bytes = nextBytes;
    count += 1;
    if (side === "older") start = index;
    else end = index;
    return true;
  };

  if (anchorIndex < 0) {
    if (options.preference === "older") {
      while (tryInclude(end + 1, "newer")) { /* The next failed row ends the contiguous window. */ }
    } else {
      while (tryInclude(start - 1, "older")) { /* The next failed row ends the contiguous window. */ }
    }
  } else {
    const firstSide = options.preference;
    const secondSide = firstSide === "older" ? "newer" : "older";
    const fillSide = (side: "older" | "newer") => {
      while (tryInclude(side === "older" ? start - 1 : end + 1, side)) {
        /* A contiguous window cannot skip a row that exceeds the remaining budget. */
      }
    };
    fillSide(firstSide);
    fillSide(secondSide);
  }

  return {
    messages: messages.slice(start, end + 1),
    evictedOlder: start > 0,
    evictedNewer: end < messages.length - 1,
  };
}
