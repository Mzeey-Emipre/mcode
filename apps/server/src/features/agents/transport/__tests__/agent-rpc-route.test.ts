import { describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "../../../../application/transport/ws-router.js";
import { routeAgentRpc, type AgentRouterDeps } from "../agent-rpc.js";

describe("routeMessage Agent RPCs", () => {
  it("retries the recovered command with its raw display content", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const retry = vi.fn(async (_executionId, dispatch) => {
      await dispatch({
        threadId: "thread-1",
        content: "Retry this work",
        model: "gpt-5",
      });
    });

    const response = await routeMessage(JSON.stringify({
      id: "retry-1",
      method: "agent.retry",
      params: { executionId: "00000000-0000-4000-8000-000000000001" },
    }), {
      agentService: { sendMessage },
      turnRecoveryService: { retry },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "retry-1", result: undefined });
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: "thread-1",
      content: "Retry this work",
      displayContent: "Retry this work",
      model: "gpt-5",
    });
  });

  it("starts a watcher for a returned worktree thread", async () => {
    const createAndSend = vi.fn().mockResolvedValue({
      id: "thread-2",
      mode: "worktree",
      worktree_path: "C:/repo-worktree",
    });
    const watchThreadWorktree = vi.fn();

    const response = await routeMessage(JSON.stringify({
      id: "create-1",
      method: "agent.createAndSend",
      params: {
        workspaceId: "workspace-1",
        content: "Start work",
        model: "gpt-5",
      },
    }), {
      agentService: { createAndSend },
      gitWatcherService: { watchThreadWorktree },
    } as unknown as RouterDeps);

    expect(response.error).toBeUndefined();
    expect(watchThreadWorktree).toHaveBeenCalledWith("thread-2", "C:/repo-worktree");
  });

  it("uses the default plan-question permission mode", async () => {
    const answerQuestions = vi.fn().mockResolvedValue(undefined);

    const response = await routeMessage(JSON.stringify({
      id: "answer-1",
      method: "agent.answerQuestions",
      params: {
        threadId: "thread-1",
        answers: [],
        reasoningLevel: "high",
        contextWindow: "1m",
        thinking: true,
      },
    }), {
      planTurnService: { answerQuestions },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "answer-1", result: undefined });
    expect(answerQuestions).toHaveBeenCalledWith(
      "thread-1",
      [],
      "default",
      "high",
      "1m",
      true,
    );
  });

  it("falls through from thread-control permission requests to agent requests", async () => {
    const calls: string[] = [];
    const respondToApproval = vi.fn(async () => {
      calls.push("thread-control");
      return false;
    });
    const respondToPermission = vi.fn(() => {
      calls.push("agent");
    });

    const response = await routeMessage(JSON.stringify({
      id: "permission-1",
      method: "permission.respond",
      params: { requestId: "request-1", decision: "allow" },
    }), {
      threadControlService: { respondToApproval },
      agentPermissionService: { respondToPermission },
    } as unknown as RouterDeps);

    expect(response).toEqual({ id: "permission-1", result: undefined });
    expect(calls).toEqual(["thread-control", "agent"]);
  });
});

describe("routeAgentRpc", () => {
  it("does not delay a new worktree thread when its watcher fails", async () => {
    const thread = {
      id: "thread-2",
      mode: "worktree",
      worktree_path: "C:/repo-worktree",
    };
    const createAndSend = vi.fn().mockResolvedValue(thread);
    const watchThreadWorktree = vi.fn().mockRejectedValue(new Error("watch failed"));

    await expect(routeAgentRpc("agent.createAndSend", {
      workspaceId: "workspace-1",
      content: "Start work",
      model: "gpt-5",
    }, {
      agentService: { createAndSend },
      gitWatcherService: { watchThreadWorktree },
    } as unknown as AgentRouterDeps)).resolves.toBe(thread);

    expect(createAndSend).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      content: "Start work",
      displayContent: "Start work",
      model: "gpt-5",
    });
    expect(watchThreadWorktree).toHaveBeenCalledWith("thread-2", "C:/repo-worktree");
  });
});
