import { describe, expect, it } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { BrowserEvaluationEventSanitizer } from "../browser-evaluation-event-sanitizer.js";

describe("BrowserEvaluationEventSanitizer", () => {
  it.each([
    "browser_evaluate",
    "mcp__mcode-browser__browser_evaluate",
  ])("removes evaluation source and result from %s events", (toolName) => {
    const sanitizer = new BrowserEvaluationEventSanitizer();
    const use = sanitizer.sanitize({
      type: AgentEventType.ToolUse,
      threadId: "thread-1",
      toolCallId: "call-1",
      toolName,
      toolInput: { expression: "globalThis.SECRET_SOURCE", observationRef: "observation-1" },
    });
    const result = sanitizer.sanitize({
      type: AgentEventType.ToolResult,
      threadId: "thread-1",
      toolCallId: "call-1",
      output: '{"valueJson":"SECRET_RESULT"}',
      isError: false,
      outputTruncated: true,
      outputTotalBytes: 999,
      outputArtifactPath: "C:\\secret-result.txt",
      toolInput: { expression: "globalThis.SECRET_SOURCE" },
    });

    expect(use).toMatchObject({ toolInput: {} });
    expect(JSON.stringify(use)).not.toContain("SECRET_SOURCE");
    expect(result).toMatchObject({ output: "", toolInput: {}, isError: false });
    expect(result).not.toHaveProperty("outputTruncated");
    expect(result).not.toHaveProperty("outputTotalBytes");
    expect(result).not.toHaveProperty("outputArtifactPath");
    expect(JSON.stringify(result)).not.toContain("SECRET_RESULT");
    expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE");
  });

  it("preserves unrelated tool events", () => {
    const sanitizer = new BrowserEvaluationEventSanitizer();
    const event = {
      type: AgentEventType.ToolUse,
      threadId: "thread-1",
      toolCallId: "call-1",
      toolName: "browser_inspect",
      toolInput: { includeDiagnostics: true },
    } satisfies AgentEvent;

    expect(sanitizer.sanitize(event)).toBe(event);
  });
});
