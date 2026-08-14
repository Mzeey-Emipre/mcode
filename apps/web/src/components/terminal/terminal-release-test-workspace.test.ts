import { describe, expect, it, vi } from "vitest";
import { bootstrapTerminalReleaseTestWorkspace } from "./terminal-release-test-workspace";

describe("terminal release-test workspace bootstrap", () => {
  it("loads, re-reads, and activates the first workspace when none is active", async () => {
    let state = {
      workspaces: [] as { id: string }[],
      activeWorkspaceId: null as string | null,
    };
    const loadWorkspaces = vi.fn(async () => {
      state = { ...state, workspaces: [{ id: "fixture" }] };
    });
    const setActiveWorkspace = vi.fn((id: string) => {
      state = { ...state, activeWorkspaceId: id };
    });

    const id = await bootstrapTerminalReleaseTestWorkspace(() => ({
      ...state,
      loadWorkspaces,
      setActiveWorkspace,
    }));

    expect(loadWorkspaces).toHaveBeenCalledOnce();
    expect(setActiveWorkspace).toHaveBeenCalledWith("fixture");
    expect(id).toBe("fixture");
  });

  it("preserves an existing active workspace", async () => {
    const loadWorkspaces = vi.fn().mockResolvedValue(undefined);
    const setActiveWorkspace = vi.fn();
    const id = await bootstrapTerminalReleaseTestWorkspace(() => ({
      workspaces: [{ id: "first" }, { id: "active" }],
      activeWorkspaceId: "active",
      loadWorkspaces,
      setActiveWorkspace,
    }));

    expect(id).toBe("active");
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });

  it("throws when the workspace list is empty", async () => {
    await expect(
      bootstrapTerminalReleaseTestWorkspace(() => ({
        workspaces: [],
        activeWorkspaceId: null,
        loadWorkspaces: vi.fn().mockResolvedValue(undefined),
        setActiveWorkspace: vi.fn(),
      })),
    ).rejects.toThrow("Terminal release-test workspace is missing");
  });
});
