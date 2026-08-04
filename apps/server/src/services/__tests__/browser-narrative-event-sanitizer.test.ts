import { describe, expect, it } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { BrowserNarrativeEventSanitizer } from "../browser-narrative-event-sanitizer.js";

describe("BrowserNarrativeEventSanitizer", () => {
  it.each([
    "browser_evaluate",
    "mcp__mcode-browser__browser_evaluate",
  ])("removes evaluation source and result from %s events", (toolName) => {
    const sanitizer = new BrowserNarrativeEventSanitizer(
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

    expect(use).toMatchObject({ toolInput: { operation: "browser_evaluate" } });
    expect(JSON.stringify(use)).not.toContain("SECRET_SOURCE");
    expect(result).toMatchObject({
      toolInput: { operation: "browser_evaluate" },
      isError: false,
    });
    expect(result).not.toHaveProperty("outputTruncated");
    expect(result).not.toHaveProperty("outputTotalBytes");
    expect(result).not.toHaveProperty("outputArtifactPath");
    expect(result.type).toBe(AgentEventType.ToolResult);
    if (result.type !== AgentEventType.ToolResult) throw new Error("Expected a tool result");
    expect(result.output).toBe('{"operation":"browser_evaluate","outcome":"completed"}');
    expect(JSON.stringify(result)).not.toContain("SECRET_RESULT");
    expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE");
  });

  it("preserves unrelated tool events", () => {
    const sanitizer = new BrowserNarrativeEventSanitizer();
    const event = {
      type: AgentEventType.ToolUse,
      threadId: "thread-1",
      toolCallId: "call-1",
      toolName: "Read",
      toolInput: { includeDiagnostics: true },
    } satisfies AgentEvent;

    expect(sanitizer.sanitize(event)).toBe(event);
  });

  it("preserves unrelated results without retaining evaluation correlations", () => {
    const evaluationToolNames = new Map<string, string>();
    const sanitizer = new BrowserNarrativeEventSanitizer(
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

    expect(evaluationResult).toMatchObject({
      output: '{"operation":"browser_evaluate","outcome":"completed"}',
    });
    expect(evaluationResult).not.toHaveProperty("toolInput");
    expect(evaluationResult).not.toHaveProperty("outputArtifactPath");
    expect(sanitizer.sanitize(unrelatedResult)).toBe(unrelatedResult);
  });

  it.each([
    "browser_open",
    "mcp__mcode-browser__browser_inspect",
    "mcp__mcode-browser__browser_act",
    "mcode-browser.browser_tabs",
  ])("removes Browser content from %s events", (toolName) => {
    const sanitizer = new BrowserNarrativeEventSanitizer(
      (_threadId, toolCallId) => toolCallId === "call-1" ? toolName : undefined,
    );
    const use = sanitizer.sanitize({
      type: AgentEventType.ToolUse,
      threadId: "thread-1",
      toolCallId: "call-1",
      toolName,
      toolInput: {
        url: "https://example.test/?token=SECRET_URL",
        text: "SECRET_TYPED_VALUE",
        observationRef: "SECRET_OBSERVATION",
        steps: [{ operation: "type", text: "SECRET_STEP_VALUE" }],
      },
    });
    const result = sanitizer.sanitize({
      type: AgentEventType.ToolResult,
      threadId: "thread-1",
      toolCallId: "call-1",
      output: JSON.stringify({
        operation: "act",
        outcome: "completed",
        receipts: [{ index: 0, operation: "type", status: "applied", message: "SECRET_MESSAGE" }],
        snapshot: { visibleText: "SECRET_BODY" },
      }),
      isError: false,
      outputArtifactPath: "C:\\SECRET_RESULT.txt",
    });

    expect(JSON.stringify(use)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result).not.toHaveProperty("outputArtifactPath");
  });
});
