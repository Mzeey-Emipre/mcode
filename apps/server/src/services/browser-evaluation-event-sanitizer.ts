import { AgentEventType, type AgentEvent } from "@mcode/contracts";

const MAX_TRACKED_EVALUATIONS = 1_024;

function evaluationCallKey(threadId: string, toolCallId: string): string {
  return JSON.stringify([threadId, toolCallId]);
}

function isBrowserEvaluationTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized === "browser_evaluate" || normalized.endsWith("_browser_evaluate");
}

/** Removes privileged Browser evaluation content at the provider-event boundary. */
export class BrowserEvaluationEventSanitizer {
  private readonly evaluationCalls = new Set<string>();

  /** Returns a content-free event while preserving tool identity and status. */
  sanitize(event: AgentEvent): AgentEvent {
    if (event.type === AgentEventType.ToolUse && isBrowserEvaluationTool(event.toolName)) {
      const key = evaluationCallKey(event.threadId, event.toolCallId);
      while (this.evaluationCalls.size >= MAX_TRACKED_EVALUATIONS) {
        const oldest = this.evaluationCalls.values().next().value as string | undefined;
        if (!oldest) break;
        this.evaluationCalls.delete(oldest);
      }
      this.evaluationCalls.add(key);
      return { ...event, toolInput: {} };
    }

    if (event.type !== AgentEventType.ToolResult) return event;
    const key = evaluationCallKey(event.threadId, event.toolCallId);
    if (!this.evaluationCalls.delete(key)) return event;
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
