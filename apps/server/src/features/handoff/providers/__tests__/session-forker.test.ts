import { describe, expect, it, vi } from "vitest";
import type { ForkRequest } from "@mcode/contracts";
import type { Thread, Message } from "@mcode/contracts";
import { CleanForker, DeterministicForker } from "../session-forker.js";

const parent = {
  id: "t_parent",
  workspace_id: "w_1",
  title: "DB migration",
  branch: "main",
  provider: "claude",
  model: "claude-opus-4-7",
  status: "active",
  worktree_path: null,
  worktree_managed: true,
  sdk_session_id: "sdk_1",
} as unknown as Thread;

const messages: Message[] = [
  { id: "m_1", thread_id: "t_parent", role: "user", content: "Should we use Postgres?", sequence: 1 } as unknown as Message,
  { id: "m_2", thread_id: "t_parent", role: "assistant", content: "Yes because...", sequence: 2 } as unknown as Message,
];

function baseReq(overrides: Partial<ForkRequest> = {}): ForkRequest {
  return {
    parentThreadId: "t_parent",
    forkedFromMessageId: "m_2",
    forkAnchorRole: "assistant",
    prompt: "Generate a handoff.",
    cwd: "/tmp/cwd",
    parentSdkSessionId: "sdk_1",
    conversationHistory: "User: hi\nAssistant: hello",
    messagesUpToFork: messages,
    parentThread: parent,
    childThreadId: "t_child",
    ...overrides,
  };
}

describe("DeterministicForker", () => {
  it("produces a path-D artifact from the message replay", async () => {
    const forker = new DeterministicForker();
    const artifact = await forker.fork(baseReq({ forkReason: "quota" }));

    expect(artifact.meta.ladderStep).toBe("D");
    expect(artifact.meta.generatedBy).toBe("deterministic");
    expect(artifact.meta.providerErrorOnGenerate).toBe("quota");
    expect(artifact.meta.childThreadId).toBe("t_child");
    expect(artifact.meta.characterCount).toBe(artifact.markdown.length);
    expect(artifact.markdown.length).toBeGreaterThan(0);
  });

  it("defaults forkReason to null when omitted (path D was the only option)", async () => {
    const forker = new DeterministicForker();
    const artifact = await forker.fork(baseReq());
    expect(artifact.meta.providerErrorOnGenerate).toBeNull();
  });
});

describe("CleanForker", () => {
  it("delegates to runSideChannelQuery and wraps a path-B artifact", async () => {
    const runSideChannelQuery = vi.fn(async (args: { parentSdkSessionId: string; cwd: string }) => {
      void args;
      return "# Handoff\n\n## Goal\nX";
    });
    const forker = new CleanForker({ id: "claude", runSideChannelQuery });
    const artifact = await forker.fork(baseReq());

    expect(runSideChannelQuery).toHaveBeenCalledOnce();
    const args = runSideChannelQuery.mock.calls[0][0];
    expect(args.parentSdkSessionId).toBe("sdk_1");
    expect(args.cwd).toBe("/tmp/cwd");
    expect(artifact.meta.ladderStep).toBe("B");
    expect(artifact.meta.generatedBy).toBe("provider");
  });

  it("passes an empty session id through when parentSdkSessionId is missing (B-prime)", async () => {
    const runSideChannelQuery = vi.fn(async (args: { parentSdkSessionId: string }) => {
      void args;
      return "# Handoff";
    });
    const forker = new CleanForker({ id: "claude", runSideChannelQuery });
    await forker.fork(baseReq({ parentSdkSessionId: null }));
    const args = runSideChannelQuery.mock.calls[0][0];
    expect(args.parentSdkSessionId).toBe("");
  });
});
