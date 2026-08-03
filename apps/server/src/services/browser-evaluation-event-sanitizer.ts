import { AgentEventType, type AgentEvent } from "@mcode/contracts";

function isBrowserEvaluationTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized === "browser_evaluate" || normalized.endsWith("_browser_evaluate");
}

/** Removes privileged Browser evaluation content at the provider-event boundary. */
export class BrowserEvaluationEventSanitizer {
  constructor(
    private readonly resolveToolName: (threadId: string, toolCallId: string) => string | undefined = () => undefined,
  ) {}

  /** Returns a content-free event while preserving tool identity and status. */
  sanitize(event: AgentEvent): AgentEvent {
    if (event.type === AgentEventType.ToolUse && isBrowserEvaluationTool(event.toolName)) {
      return { ...event, toolInput: {} };
    }

    if (event.type !== AgentEventType.ToolResult) return event;
    const toolName = this.resolveToolName(event.threadId, event.toolCallId);
    if (!toolName || !isBrowserEvaluationTool(toolName)) return event;
    const {
      outputTruncated: _outputTruncated,
      outputTotalBytes: _outputTotalBytes,
      outputArtifactPath: _outputArtifactPath,
      ...contentFreeEvent
    } = event;
    return {
      ...contentFreeEvent,
      output: "",
      toolInput: {},
    };
  }
}
