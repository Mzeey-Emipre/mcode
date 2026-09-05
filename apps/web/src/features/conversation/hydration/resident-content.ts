import type { ThreadRecord } from "@/stores/thread-record";

/** Fields that keep a thread paintable while persisted history is hydrating. */
export type ResidentContentRecord = Pick<
  ThreadRecord,
  "messages" | "sessionNotices" | "streaming" | "streamingPreview" | "toolCalls" | "thoughtSegments" | "hooks"
>;

/** Returns whether a thread has any transcript or live-turn content to keep visible. */
export function hasResidentContent(record: ResidentContentRecord): boolean {
  return record.messages.length > 0
    || record.sessionNotices.length > 0
    || record.streaming.length > 0
    || record.streamingPreview.length > 0
    || record.toolCalls.length > 0
    || record.thoughtSegments.length > 0
    || record.hooks.length > 0;
}
