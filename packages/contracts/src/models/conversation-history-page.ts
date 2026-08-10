/** Maximum messages accepted in one directional conversation-history page. */
export const CONVERSATION_HISTORY_PAGE_MAX_MESSAGES = 100;

/** Minimum response-byte budget accepted for one conversation-history page. */
export const CONVERSATION_HISTORY_PAGE_MIN_BYTES = 65_536;

/** Maximum encoded bytes accepted for one conversation-history page response. */
export const CONVERSATION_HISTORY_PAGE_MAX_BYTES = 4_194_304;

/** Maximum encoded bytes accepted for one conversation-history page request. */
export const CONVERSATION_HISTORY_PAGE_MAX_REQUEST_BYTES = 4_096;

/** Returns the UTF-8 size of one JSON transport value. */
export function conversationHistoryPageBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
