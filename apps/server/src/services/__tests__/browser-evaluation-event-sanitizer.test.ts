import { describe, expect, it } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { BrowserEvaluationEventSanitizer } from "../browser-evaluation-event-sanitizer.js";

describe("BrowserEvaluationEventSanitizer", () => {
  it.each([
    "browser_evaluate",
    "mcp__mcode-browser__browser_evaluate",
  ])("removes evaluation source and result from %s events", (toolName) => {
    const sanitizer = new BrowserEvaluationEventSanitizer(
      (_threadId, toolCallId) => toolCallId === "call-1" ? toolName : undefined,
    );
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

  it("preserves unrelated results without retaining evaluation correlations", () => {
    const evaluationToolNames = new Map<string, string>();
    const sanitizer = new BrowserEvaluationEventSanitizer(
      (_threadId, toolCallId) => evaluationToolNames.get(toolCallId),
    );
    for (let index = 0; index <= 1_024; index++) {
      evaluationToolNames.set(`call-${index}`, "browser_evaluate");
      sanitizer.sanitize({
        type: AgentEventType.ToolUse,
        threadId: "thread-overflow",
        toolCallId: `call-${index}`,
        toolName: "browser_evaluate",
        toolInput: { expression: `globalThis.SECRET_${index}` },
      });
    }

    const evaluationResult = sanitizer.sanitize({
      type: AgentEventType.ToolResult,
      threadId: "thread-overflow",
      toolCallId: "call-0",
      output: "SECRET_EVICTED_RESULT",
      isError: false,
      outputArtifactPath: "C:\\secret-result.txt",
    });
    const unrelatedResult = {
      type: AgentEventType.ToolResult,
      threadId: "thread-overflow",
      toolCallId: "unrelated-call",
      output: "ordinary output",
      isError: false,
    } satisfies AgentEvent;

    expect(evaluationResult).toMatchObject({ output: "", toolInput: {} });
    expect(evaluationResult).not.toHaveProperty("outputArtifactPath");
    expect(sanitizer.sanitize(unrelatedResult)).toBe(unrelatedResult);
  });
});
