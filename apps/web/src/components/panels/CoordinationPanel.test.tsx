import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadControlProjection } from "@mcode/contracts";
import { CoordinationPanel } from "./CoordinationPanel";
import { threadControlKey, useThreadControlStore } from "@/stores/threadControlStore";

const { respondToPermissionMock, readThreadControlMock } = vi.hoisted(() => ({
  respondToPermissionMock: vi.fn(async () => undefined),
  readThreadControlMock: vi.fn(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({
    readThreadControl: readThreadControlMock,
    respondToPermission: respondToPermissionMock,
    sendThreadControl: vi.fn(),
    stopThreadControl: vi.fn(),
  }),
}));

const IDENTITY = { workspaceId: "workspace-1", threadId: "thread-1" };
const projection: ThreadControlProjection = {
  identity: IDENTITY,
  thread: {
    ...IDENTITY,
    title: "Coordinator",
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    state: { status: "waiting_for_approval", approvalId: "approval-1" },
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  },
  messages: [{
    messageId: "message-1",
    role: "user",
    content: "Delegate this work",
    createdAt: "2026-07-29T00:00:00.000Z",
    origin: {
      type: "thread",
      sourceThreadId: "source-thread",
      sourceTurnId: "turn-1",
      sourceProviderId: "claude",
    },
  }],
  hasMoreMessages: false,
  relation: {
    source: {
      workspaceId: "workspace-2",
      threadId: "source-thread",
      title: "Source",
      providerId: "claude",
      modelId: "claude-sonnet",
      state: { status: "running" },
    },
    destination: {
      ...IDENTITY,
      title: "Coordinator",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      state: { status: "waiting_for_approval", approvalId: "approval-1" },
    },
    creatorTurnId: "turn-1",
    creatorToolCallId: "tool-1",
    creationKind: "thread_delegation",
  },
  children: [{
    source: {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      title: "Coordinator",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      state: { status: "running" },
    },
    destination: {
      workspaceId: "workspace-2",
      threadId: "destination-thread",
      title: "Worker",
      providerId: "claude",
      modelId: "claude-sonnet",
      state: { status: "completed" },
    },
    creatorTurnId: "turn-2",
    creatorToolCallId: "tool-2",
    creationKind: "thread_delegation",
  }],
  approvals: [{
    requestId: "approval-1",
    threadId: "thread-1",
    toolName: "thread_send",
    title: "Send a message to another thread",
    input: { threadId: "destination-thread", message: "Follow up" },
    ownerWorkspaceId: "workspace-1",
    ownerThreadId: "thread-1",
    sourceThreadId: "source-thread",
    operation: "thread_send",
  }],
};

describe("CoordinationPanel", () => {
  beforeEach(() => {
    readThreadControlMock.mockReset();
    readThreadControlMock.mockResolvedValue({ status: "found", projection });
    respondToPermissionMock.mockClear();
    useThreadControlStore.setState({
      entries: {
        [threadControlKey(IDENTITY)]: { projection, loading: false, error: null, epoch: 1 },
      },
    });
  });

  it("shows persisted provider provenance, lifecycle, and human-owned approval controls", async () => {
    const user = userEvent.setup();
    render(<CoordinationPanel workspaceId={IDENTITY.workspaceId} threadId={IDENTITY.threadId} />);

    expect(screen.getByRole("region", { name: "Thread coordination" })).toBeInTheDocument();
    expect(screen.getByLabelText("Current thread status: Waiting for approval (approval-1)")).toBeInTheDocument();
    expect(screen.getByText("From Source (thread origin)")).toBeInTheDocument();
    expect(screen.getByLabelText("Status: Completed")).toBeInTheDocument();
    expect(screen.getByText("Owned by thread-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(respondToPermissionMock).toHaveBeenCalledWith("approval-1", "allow");
  });
});
