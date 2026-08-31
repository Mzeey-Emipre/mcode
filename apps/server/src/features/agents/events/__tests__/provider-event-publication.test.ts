import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { publishParentProviderEvent } from "../provider-event-publication.js";

function buildPublicationDeps() {
  return {
    publishAgentEvent: vi.fn(),
    updateThreadStatus: vi.fn(),
    publishThreadStatus: vi.fn(),
  };
}

describe("provider event publication ownership", () => {

  it("does not publish generated attachments to the parent UI", () => {
    const deps = buildPublicationDeps();
    const event: AgentEvent = {
      type: AgentEventType.GeneratedAttachment,
      threadId: "parent-thread",
      attachment: {
        id: "attachment-1",
        name: "capture.png",
        mimeType: "image/png",
        sizeBytes: 1,
      },
    };

    expect(publishParentProviderEvent(event, event, deps)).toBe(false);
    expect(deps.publishAgentEvent).not.toHaveBeenCalled();
  });

  it("publishes a parent completion and updates its status", () => {
    const deps = buildPublicationDeps();
    const parentEvent: AgentEvent = {
      type: AgentEventType.TurnComplete,
      threadId: "parent-thread",
      reason: "completed",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
    };

    expect(publishParentProviderEvent(parentEvent, parentEvent, deps)).toBe(true);
    expect(deps.publishAgentEvent).toHaveBeenCalledWith(parentEvent);
    expect(deps.updateThreadStatus).toHaveBeenCalledWith("parent-thread", "completed");
    expect(deps.publishThreadStatus).toHaveBeenCalledWith({
      threadId: "parent-thread",
      status: "completed",
    });
  });

  it("publishes a parent error and updates its status", () => {
    const deps = buildPublicationDeps();
    const parentEvent: AgentEvent = {
      type: AgentEventType.Error,
      threadId: "parent-thread",
      error: "parent provider disconnected",
    };

    expect(publishParentProviderEvent(parentEvent, parentEvent, deps)).toBe(true);
    expect(deps.publishAgentEvent).toHaveBeenCalledWith(parentEvent);
    expect(deps.updateThreadStatus).toHaveBeenCalledWith("parent-thread", "errored");
    expect(deps.publishThreadStatus).toHaveBeenCalledWith({
      threadId: "parent-thread",
      status: "errored",
    });
  });

  it.each([
    ["interrupted", "interrupted"],
    ["cancelled", "interrupted"],
    ["completed", "completed"],
    ["errored", "errored"],
  ] as const)("publishes Ended outcome %s as thread status %s", (outcome, status) => {
    const deps = buildPublicationDeps();
    const event: AgentEvent = {
      type: AgentEventType.Ended,
      threadId: "parent-thread",
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
      outcome,
    };

    expect(publishParentProviderEvent(event, event, deps)).toBe(true);
    expect(deps.updateThreadStatus).toHaveBeenCalledWith("parent-thread", status);
    expect(deps.publishThreadStatus).toHaveBeenCalledWith({
      threadId: "parent-thread",
      status,
    });
  });

  it("does not publish a terminal status for an outcome-less Ended", () => {
    const deps = buildPublicationDeps();
    const event: AgentEvent = {
      type: AgentEventType.Ended,
      threadId: "parent-thread",
      turnExecutionId: "00000000-0000-4000-8000-000000000001",
    };

    expect(publishParentProviderEvent(event, event, deps)).toBe(false);
    expect(deps.publishAgentEvent).not.toHaveBeenCalled();
    expect(deps.updateThreadStatus).not.toHaveBeenCalled();
    expect(deps.publishThreadStatus).not.toHaveBeenCalled();
  });
});
