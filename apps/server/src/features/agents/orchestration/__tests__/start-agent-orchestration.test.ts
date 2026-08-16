import { describe, expect, it, vi } from "vitest";
import { AgentEventType, type AgentEvent } from "@mcode/contracts";
import { startAgentOrchestration } from "../start-agent-orchestration.js";

function buildOrchestration() {
  let publish: ((event: AgentEvent) => void) | undefined;
  const agentService = {
    init: vi.fn((callback: (event: AgentEvent) => void) => {
      publish = callback;
    }),
    getCurrentFileEffectTurnId: vi.fn(() => undefined),
    shouldSuppressTurnEnded: vi.fn(() => false),
    shouldSuppressTurnComplete: vi.fn(() => false),
    shouldSuppressTransientTurnError: vi.fn(() => false),
  };
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
  const publishThreadPrLinked = vi.fn();

  startAgentOrchestration({
    agentService,
    threadRepo,
    workspaceRepo: { findById: vi.fn() },
    narrativeStore: { getCurrentParentToolCallId: vi.fn(() => "agent-parent") },
    threadService: { linkPr: vi.fn() },
    githubService: { getBranchPr: vi.fn() },
    ciWatcherService: { watch: vi.fn(), unwatch: vi.fn() },
    providerRegistry: { resolveAll: vi.fn(() => []) },
    publishAgentEvent: (event: AgentEvent) => publishedEvents.push(event),
    publishPermissionRequest: vi.fn(),
    publishPermissionResolved: vi.fn(),
    publishThreadStatus,
    publishThreadPrLinked,
  } as never);

  if (!publish) throw new Error("orchestration did not register publication callback");
  return {
    publish,
    agentService,
    threadRepo,
    publishedEvents,
    publishThreadStatus,
    publishThreadPrLinked,
  };
}

describe("agent orchestration", () => {
  it("publishes enriched parent events once while keeping child and attachment events private", () => {
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
      type: AgentEventType.ToolUse,
      threadId: "thread-1",
      toolCallId: "child-tool",
      toolName: "Read",
      toolInput: {},
      codexChild: {
        nativeThreadId: "child-native-thread",
        parentCollaborationItemId: "parent-item",
      },
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
  });
});
