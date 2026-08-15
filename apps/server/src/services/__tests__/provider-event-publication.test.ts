import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { publishParentProviderEvent } from "../provider-event-publication.js";

const childEvidence = {
  nativeThreadId: "native-child-thread",
  nativeTurnId: "native-child-turn",
  parentCollaborationItemId: "call-child",
};

function buildPublicationDeps() {
  return {
    publishAgentEvent: vi.fn(),
    updateThreadStatus: vi.fn(),
    publishThreadStatus: vi.fn(),
  };
}

describe("provider event publication ownership", () => {
  it("does not publish child content or lifecycle into the parent UI", () => {
    const deps = buildPublicationDeps();
    const childEvents: AgentEvent[] = [
      {
        type: AgentEventType.Message,
        threadId: "parent-thread",
        content: "child response must stay in its detail chat",
        tokens: null,
        codexChild: childEvidence,
      },
      {
        type: AgentEventType.TurnComplete,
        threadId: "parent-thread",
        reason: "completed",
        costUsd: null,
        tokensIn: 1,
        tokensOut: 1,
        codexChild: childEvidence,
      },
      {
        type: AgentEventType.Error,
        threadId: "parent-thread",
        error: "child error",
        codexChild: childEvidence,
      },
      {
        type: AgentEventType.Ended,
        threadId: "parent-thread",
        codexChild: childEvidence,
      },
    ];

    for (const event of childEvents) {
      expect(publishParentProviderEvent(event, event, deps)).toBe(false);
    }

    expect(deps.publishAgentEvent).not.toHaveBeenCalled();
    expect(deps.updateThreadStatus).not.toHaveBeenCalled();
    expect(deps.publishThreadStatus).not.toHaveBeenCalled();
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
});
