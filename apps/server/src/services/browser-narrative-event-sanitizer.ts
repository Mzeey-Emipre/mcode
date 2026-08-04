import {
  AgentEventType,
  projectBrowserNarrativeInput,
  projectBrowserNarrativeResult,
  serializeBrowserNarrativeResult,
  type AgentEvent,
} from "@mcode/contracts";

/** Replaces Browser provider events with content-free narrative projections. */
export class BrowserNarrativeEventSanitizer {
  constructor(
    private readonly resolveToolName: (threadId: string, toolCallId: string) => string | undefined = () => undefined,
  ) {}

  /** Returns a bounded Browser event while preserving tool identity and outcome. */
  sanitize(event: AgentEvent): AgentEvent {
    if (event.type === AgentEventType.ToolUse) {
      const projectedInput = projectBrowserNarrativeInput(event.toolName, event.toolInput);
      return projectedInput ? { ...event, toolInput: { ...projectedInput } } : event;
    }

    if (event.type !== AgentEventType.ToolResult) return event;
    const toolName = this.resolveToolName(event.threadId, event.toolCallId);
    if (!toolName) return event;
    const projectedResult = projectBrowserNarrativeResult(toolName, event.output, event.isError);
    if (!projectedResult) return event;
    const projectedInput = event.toolInput
      ? projectBrowserNarrativeInput(toolName, event.toolInput)
      : null;
    const {
      outputTruncated: _outputTruncated,
      outputTotalBytes: _outputTotalBytes,
      outputArtifactPath: _outputArtifactPath,
      toolInput: _toolInput,
      ...contentFreeEvent
    } = event;
    return {
      ...contentFreeEvent,
      output: serializeBrowserNarrativeResult(projectedResult),
      ...(projectedInput ? { toolInput: { ...projectedInput } } : {}),
    };
  }
}
