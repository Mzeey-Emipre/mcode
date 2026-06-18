import { afterEach, describe, expect, it, vi } from "vitest";
import { routeMessage, type RouterDeps } from "./ws-router.js";
import {
  resetTransportPayloadValidatorForTest,
  setTransportPayloadValidatorForTest,
  type TransportPayloadValidator,
} from "./payload-validation.js";

describe("routeMessage result validation seam", () => {
  afterEach(() => {
    resetTransportPayloadValidatorForTest();
  });

  it("delegates RPC result validation to the configured adapter", async () => {
    const validateRpcResult = vi.fn();
    const validator: TransportPayloadValidator = {
      validatePush: (_channel, data) => ({ ok: true, data }),
      validateRpcResult,
    };
    setTransportPayloadValidatorForTest(validator);

    const response = await routeMessage(
      JSON.stringify({ id: "req-1", method: "app.version", params: {} }),
      {} as RouterDeps,
    );

    expect(response.id).toBe("req-1");
    expect(typeof response.result).toBe("string");
    expect(validateRpcResult).toHaveBeenCalledWith(
      "app.version",
      response.result,
      expect.anything(),
    );
  });
});

describe("routeMessage git.getRemoteUrl", () => {
  it("resolves the git path from a workspace thread before calling GitService", async () => {
    const getRemoteUrl = vi.fn().mockResolvedValue({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    const resolveWorkingDir = vi.fn().mockReturnValue("C:/repo-worktree");
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "ws-1",
          mode: "worktree",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitService: {
        getRemoteUrl,
        resolveWorkingDir,
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-remote",
        method: "git.getRemoteUrl",
        params: { workspaceId: "ws-1", threadId: "thread-1" },
      }),
      deps,
    );

    expect(response.result).toEqual({
      webUrl: "https://github.com/Mzeey-Empire/mcode",
      label: "Mzeey-Empire/mcode",
    });
    expect(resolveWorkingDir).toHaveBeenCalledWith(
      "C:/repo",
      "worktree",
      "C:/repo-worktree",
    );
    expect(getRemoteUrl).toHaveBeenCalledWith("C:/repo-worktree");
  });

  it("rejects a thread from another workspace before running git", async () => {
    const getRemoteUrl = vi.fn();
    const deps = {
      workspaceService: {
        findById: vi.fn().mockReturnValue({ id: "ws-1", path: "C:/repo" }),
      },
      threadRepo: {
        findById: vi.fn().mockReturnValue({
          id: "thread-1",
          workspace_id: "ws-2",
          mode: "worktree",
          worktree_path: "C:/repo-worktree",
        }),
      },
      gitService: {
        getRemoteUrl,
        resolveWorkingDir: vi.fn(),
      },
    } as unknown as RouterDeps;

    const response = await routeMessage(
      JSON.stringify({
        id: "req-remote",
        method: "git.getRemoteUrl",
        params: { workspaceId: "ws-1", threadId: "thread-1" },
      }),
      deps,
    );

    expect(response.error?.message).toContain(
      "Thread thread-1 does not belong to workspace ws-1",
    );
    expect(getRemoteUrl).not.toHaveBeenCalled();
  });
});
