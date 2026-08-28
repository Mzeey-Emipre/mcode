import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { startAgentOrchestration } from "../start-agent-orchestration.js";
import { AgentEventPublicationRegistry } from "../agent-event-publication-registry.js";

function buildOrchestration() {
  let publish: ((event: AgentEvent) => void) | undefined;
  const runtime = {
    getCurrentFileEffectTurnId: vi.fn(() => undefined),
    shouldSuppressTurnEnded: vi.fn(() => false),
    shouldSuppressTurnComplete: vi.fn(() => false),
    shouldSuppressTransientTurnError: vi.fn(() => false),
  };
  const publicationRegistry = new AgentEventPublicationRegistry();
  publicationRegistry.bind = vi.fn((callback: (event: AgentEvent) => void) => {
    publish = callback;
  });
  const threadRepo = {
    findById: vi.fn(() => ({
      id: "thread-1",
      provider: "claude",
      branch: "main",
      workspace_id: "workspace-1",
      pr_number: null,
      pr_status: null,
    })),
    updateStatus: vi.fn(),
  };
  const publishedEvents: AgentEvent[] = [];
  const publishThreadStatus = vi.fn();
  const pullRequestCompletionEffect = { schedule: vi.fn() };

  startAgentOrchestration({
    runtime,
    publicationRegistry,
    threadRepo,
    narrativeStore: { getCurrentParentToolCallId: vi.fn(() => "agent-parent") },
    pullRequestCompletionEffect,
    providerRegistry: { resolveAll: vi.fn(() => []) },
    publishAgentEvent: (event: AgentEvent) => publishedEvents.push(event),
    publishPermissionRequest: vi.fn(),
    publishPermissionResolved: vi.fn(),
    publishThreadStatus,
  } as never);

  if (!publish) throw new Error("orchestration did not register publication callback");
  return {
    publish,
    runtime,
    threadRepo,
    publishedEvents,
    publishThreadStatus,
    pullRequestCompletionEffect,
  };
}

describe("agent orchestration", () => {
  it("publishes enriched parent events once while keeping attachments private", () => {
    const orchestration = buildOrchestration();

    orchestration.publish({
      type: AgentEventType.ToolUse,
      threadId: "thread-1",
      toolCallId: "tool-1",
      toolName: "Edit",
      toolInput: {
        file_path: "src/app.ts",
        old_string: "secret",
        new_string: "replacement",
      },
    });

    expect(orchestration.publishedEvents).toHaveLength(1);
    expect(orchestration.publishedEvents[0]).toMatchObject({
      type: AgentEventType.ToolUse,
      parentToolCallId: "agent-parent",
      toolInput: { file_path: "src/app.ts" },
    });
    expect(orchestration.publishedEvents[0]).not.toMatchObject({
      toolInput: { old_string: expect.anything(), new_string: expect.anything() },
    });

    orchestration.publish({
      type: AgentEventType.GeneratedAttachment,
      threadId: "thread-1",
      attachment: {
        id: "attachment-1",
        name: "capture.png",
        mimeType: "image/png",
        sizeBytes: 1,
      },
    });

    expect(orchestration.publishedEvents).toHaveLength(1);
  });

  it("keeps terminal status publication on the parent event path", () => {
    const orchestration = buildOrchestration();
    const event: AgentEvent = {
      type: AgentEventType.TurnComplete,
      threadId: "thread-1",
      reason: "completed",
      costUsd: null,
      tokensIn: 1,
      tokensOut: 1,
    };

    orchestration.publish(event);

    expect(orchestration.publishedEvents).toEqual([event]);
    expect(orchestration.threadRepo.updateStatus).toHaveBeenCalledWith("thread-1", "completed");
    expect(orchestration.publishThreadStatus).toHaveBeenCalledWith({
      threadId: "thread-1",
      status: "completed",
    });
    expect(orchestration.pullRequestCompletionEffect.schedule).toHaveBeenCalledWith("thread-1");
  });
});
