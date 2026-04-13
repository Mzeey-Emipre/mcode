import { describe, it, expect } from "vitest";
import { HANDOFF_MARKER, parseHandoffJson } from "../handoff.js";
import type { HandoffMetadata } from "../handoff.js";

const sampleContent = `You are continuing work.

<!-- mcode-handoff
{
  "parentThreadId": "p-1",
  "parentTitle": "Fix auth bug",
  "forkedFromMessageId": "msg-5",
  "sourceProvider": "claude",
  "sourceModel": "claude-sonnet-4-6",
  "sourceBranch": "feature/auth-fix",
  "sourceWorktreePath": null,
  "sourceHead": "abc1234",
  "recentFilesChanged": ["auth.ts"],
  "openTasks": [{ "content": "Write tests", "status": "pending" }]
}
-->`;

describe("HANDOFF_MARKER", () => {
  it("is the expected sentinel string", () => {
    expect(HANDOFF_MARKER).toBe("<!-- mcode-handoff");
  });
});

describe("parseHandoffJson", () => {
  it("parses valid handoff content", () => {
    const result = parseHandoffJson(sampleContent);
    expect(result).not.toBeNull();

    const meta = result as HandoffMetadata;
    expect(meta.parentThreadId).toBe("p-1");
    expect(meta.parentTitle).toBe("Fix auth bug");
    expect(meta.forkedFromMessageId).toBe("msg-5");
    expect(meta.sourceProvider).toBe("claude");
    expect(meta.sourceModel).toBe("claude-sonnet-4-6");
    expect(meta.sourceBranch).toBe("feature/auth-fix");
    expect(meta.sourceWorktreePath).toBeNull();
    expect(meta.sourceHead).toBe("abc1234");
    expect(meta.recentFilesChanged).toEqual(["auth.ts"]);
    expect(meta.openTasks).toHaveLength(1);
  });

  it("returns null for content without the marker", () => {
    expect(parseHandoffJson("just a regular message")).toBeNull();
  });

  it("returns null for malformed JSON in the handoff block", () => {
    expect(parseHandoffJson(`${HANDOFF_MARKER}\n{invalid json\n-->`)).toBeNull();
  });

  it("handles --> appearing inside a JSON string value", () => {
    const withArrow: HandoffMetadata = {
      parentThreadId: "p-1",
      parentTitle: "A --> B migration",
      forkedFromMessageId: "msg-1",
      sourceProvider: "claude",
      sourceModel: null,
      sourceBranch: "main",
      sourceWorktreePath: null,
      sourceHead: null,
      recentFilesChanged: [],
      openTasks: [{ content: "migrate A --> B", status: "pending" }],
    };
    const content = `${HANDOFF_MARKER}\n${JSON.stringify(withArrow, null, 2)}\n-->`;
    const result = parseHandoffJson(content);
    expect(result).not.toBeNull();
    expect(result!.parentTitle).toBe("A --> B migration");
    expect(result!.openTasks[0].content).toBe("migrate A --> B");
  });

  it("returns null when the closing --> is missing", () => {
    expect(parseHandoffJson(`${HANDOFF_MARKER}\n{"foo":"bar"}`)).toBeNull();
  });
});
