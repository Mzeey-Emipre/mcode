import type { AgentEvent } from "@mcode/contracts";

/** Dependencies used to publish one normalized provider event to the parent UI. */
export interface ParentProviderEventPublicationDeps {
  publishAgentEvent: (event: AgentEvent) => void;
  updateThreadStatus: (threadId: string, status: "completed" | "errored" | "interrupted") => void;
  publishThreadStatus: (payload: { threadId: string; status: "completed" | "errored" | "interrupted" }) => void;
}

/** Publish a normalized parent event and apply its legacy parent status transition. */
export function publishParentProviderEvent(
  event: AgentEvent,
  enrichedEvent: AgentEvent,
  deps: ParentProviderEventPublicationDeps,
): boolean {
  if (event.type === "generatedAttachment" || (event.type === "ended" && event.outcome === undefined)) return false;

  deps.publishAgentEvent(enrichedEvent);
  if (event.type === "turnComplete") {
    deps.updateThreadStatus(event.threadId, "completed");
    deps.publishThreadStatus({ threadId: event.threadId, status: "completed" });
  } else if (event.type === "error") {
    deps.updateThreadStatus(event.threadId, "errored");
    deps.publishThreadStatus({ threadId: event.threadId, status: "errored" });
  } else if (event.type === "ended" && event.outcome !== undefined) {
    const status = event.outcome === "completed"
      ? "completed"
      : event.outcome === "errored"
        ? "errored"
        : "interrupted";
    deps.updateThreadStatus(event.threadId, status);
    deps.publishThreadStatus({ threadId: event.threadId, status });
  }
  return true;
}
