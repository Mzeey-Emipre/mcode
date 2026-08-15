import type { AgentEvent } from "@mcode/contracts";

/** Dependencies used to publish one normalized provider event to the parent UI. */
export interface ParentProviderEventPublicationDeps {
  publishAgentEvent: (event: AgentEvent) => void;
  updateThreadStatus: (threadId: string, status: "completed" | "errored") => void;
  publishThreadStatus: (payload: { threadId: string; status: "completed" | "errored" }) => void;
}

/** Publish a normalized parent event and apply its legacy parent status transition. */
export function publishParentProviderEvent(
  event: AgentEvent,
  enrichedEvent: AgentEvent,
  deps: ParentProviderEventPublicationDeps,
): boolean {
  if ("codexChild" in event && event.codexChild !== undefined) return false;
  if (event.type === "generatedAttachment") return false;

  deps.publishAgentEvent(enrichedEvent);
  if (event.type === "turnComplete") {
    deps.updateThreadStatus(event.threadId, "completed");
    deps.publishThreadStatus({ threadId: event.threadId, status: "completed" });
  } else if (event.type === "error") {
    deps.updateThreadStatus(event.threadId, "errored");
    deps.publishThreadStatus({ threadId: event.threadId, status: "errored" });
  }
  return true;
}
