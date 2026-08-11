import { describe, expect, it } from "vitest";
import {
  CONVERSATION_REVISION_FIELD_KEYS,
  createEmptyThreadRecord,
  getThreadRecord,
  patchThreadRecord,
  type ThreadRecord,
} from "./thread-record";

describe("thread conversation revision", () => {
  it("advances once for each owned conversation field", () => {
    for (const field of CONVERSATION_REVISION_FIELD_KEYS) {
      const record = createEmptyThreadRecord();
      const records = new Map<string, ThreadRecord>([["thread-a", record]]);
      const updated = getThreadRecord(
        patchThreadRecord(records, "thread-a", {
          [field]: record[field],
        }),
        "thread-a",
      );

      expect(updated.conversationRevision, field).toBe(1);
    }
  });

  it("advances once when one patch changes multiple conversation fields", () => {
    const records = new Map<string, ThreadRecord>([["thread-a", createEmptyThreadRecord()]]);
    const updated = getThreadRecord(
      patchThreadRecord(records, "thread-a", {
        messages: [],
        streaming: "live",
        toolCalls: [],
      }),
      "thread-a",
    );

    expect(updated.conversationRevision).toBe(1);
  });

  it("does not advance for pagination and presentation state", () => {
    const records = new Map<string, ThreadRecord>([["thread-a", createEmptyThreadRecord()]]);
    const updated = getThreadRecord(
      patchThreadRecord(records, "thread-a", {
        loading: true,
        isLoadingMore: true,
        loadEpoch: 1,
      }),
      "thread-a",
    );

    expect(updated.conversationRevision).toBe(0);
  });
});
