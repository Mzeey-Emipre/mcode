import { describe, expect, it } from "vitest";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { hasResidentContent } from "../resident-content";

describe("hasResidentContent", () => {
  it.each([
    "messages",
    "sessionNotices",
    "streaming",
    "streamingPreview",
    "toolCalls",
    "thoughtSegments",
    "hooks",
  ] as const)("recognizes %s as paintable content", (field) => {
    const record = createEmptyThreadRecord();
    if (field === "streaming" || field === "streamingPreview") {
      record[field] = "content";
    } else {
      record[field] = [{}] as never;
    }

    expect(hasResidentContent(record)).toBe(true);
  });

  it("returns false for an empty record", () => {
    expect(hasResidentContent(createEmptyThreadRecord())).toBe(false);
  });
});
