import { describe, expect, it } from "vitest";
import {
  extractCursorParentToolCallId,
  resolveCursorSubagentToolName,
} from "../cursor-subagent-detection.js";

describe("extractCursorParentToolCallId", () => {
  it("reads camelCase parentToolCallId", () => {
    expect(extractCursorParentToolCallId({ parentToolCallId: "p1" })).toBe("p1");
  });
  it("reads snake_case parent_call_id", () => {
    expect(extractCursorParentToolCallId({ parent_call_id: "p2" })).toBe("p2");
  });
});

describe("resolveCursorSubagentToolName", () => {
  it("maps exploreToolCall discriminators to Agent", () => {
    expect(resolveCursorSubagentToolName("exploreToolCall", "exploreToolCall", null)).toBe(
      "Agent",
    );
  });
  it("does not remap readToolCall", () => {
    expect(resolveCursorSubagentToolName("Read", "readToolCall", null)).toBe("Read");
  });
  it("respects Explore-style titles when kind mapped to Tool", () => {
    expect(resolveCursorSubagentToolName("Tool", null, "Explore codebase")).toBe("Agent");
  });
});
